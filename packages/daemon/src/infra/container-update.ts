import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ContainerStartResult,
  type ContainerUpdateResult,
  isLinuxArch,
  LINUX_ARCHIVE_FOLDER,
  type LinuxArch,
  linuxArchiveName,
  RELEASE_VERSION,
} from "@trackwall/protocol";
import { APPLY_UPDATE_COMMAND, CONTAINER_COMMAND, CONTAINER_START } from "./args.ts";
import { writeFileAtomic } from "./atomic-write.ts";
import { runningSupervisor } from "./container-supervisor.ts";
import { isAlive, probeRunningDaemon } from "./discovery.ts";
import { download } from "./download.ts";
import { messageOf } from "./errors.ts";
import { trustedFields, verifyMinisign } from "./minisign.ts";
import { claimPidFile, pidFileHolder, releasePidFile } from "./pid-file.ts";
import { runProgram } from "./run-program.ts";
import { selfCommand } from "./self-command.ts";
import { extractTarGz } from "./tar.ts";

/**
 * `trackwall-container update <version>` (ADR-165): replaces Trackwall in a dev container with another release without
 * rebuilding the container. The command answers at once (`updating`) and leaves the work to a process in the background,
 * which downloads the Linux archive of that version and its signature into `bin/<version>.download/` of the state
 * directory, checks the signature with the key compiled into the version already installed and the file name and version
 * in its trusted comment, unpacks it, checks that the binary reports that version, stops the running daemon, records the
 * version in `bin/current` (which `trackwall-container` reads to pick the binary) and starts it. When the new daemon does
 * not answer with that version within a minute, the previous version comes back the same way. Two versions are kept.
 * Every step goes to `logs/daemon.log`.
 */

const BIN_DIR = "bin";
/** The version `trackwall-container` runs; without it, the one the Feature installed. */
export const CURRENT_FILE = "current";
const UPDATE_PID_FILE = "update.pid";
const UPDATE_ARGS = [CONTAINER_COMMAND, APPLY_UPDATE_COMMAND];
/** The archive is about 60 MB; four times that is a server sending something else. */
const ARCHIVE_MAX_BYTES = 256 * 1024 * 1024;
const SIGNATURE_MAX_BYTES = 4096;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const UNPACK_TIMEOUT_MS = 2 * 60 * 1000;
/** A stop is graceful: services and sessions end first (§1.3). */
const STOP_TIMEOUT_MS = 60_000;
/** The new daemon's first start moves state and resumes sessions before it answers. */
const ANSWER_TIMEOUT_MS = 60_000;

interface UpdateSource {
  /** The address of a release file of a version. */
  url: (version: string, file: string) => string;
  /** The key the release is signed with. */
  pubkey: string;
}

export function binDir(home: string): string {
  return join(home, BIN_DIR);
}

/** The version in `bin/current`, when it names one that is there. */
export function currentVersion(home: string): string | undefined {
  try {
    const version = readFileSync(join(binDir(home), CURRENT_FILE), "utf8").trim();
    return RELEASE_VERSION.test(version) && existsSync(join(binDir(home), version, "trackwall-daemon")) ? version : undefined;
  } catch {
    return undefined;
  }
}

function setCurrent(home: string, version: string | undefined): void {
  const file = join(binDir(home), CURRENT_FILE);
  if (version === undefined) rmSync(file, { force: true });
  else writeFileAtomic(file, `${version}\n`, 0o600);
}

function containerArch(): LinuxArch {
  const arch = process.arch;
  if (process.platform !== "linux" || !isLinuxArch(arch)) throw new Error(`no Trackwall archive for ${process.platform} ${arch}`);
  return arch;
}

type UpdateRequest = { home: string; port: number; version: string; target: string };

/** The answer of `trackwall-container update`, never an exception: starts the background process unless there is nothing to do. */
export async function containerUpdate(o: UpdateRequest): Promise<ContainerUpdateResult> {
  try {
    return await startUpdate(o);
  } catch (err) {
    return { ok: false, version: o.version, error: { code: "update-failed", message: messageOf(err) } };
  }
}

async function startUpdate(o: UpdateRequest): Promise<ContainerUpdateResult> {
  const running = await probeRunningDaemon(o.home);
  if (running?.version === o.target) return { ok: true, version: o.version, status: "current", target: o.target };
  // The background process claims the lock itself; two calls in the same instant both answer `updating`, and the second
  // process finds the lock taken and says so in the log (ADR-165).
  if (pidFileHolder(join(binDir(o.home), UPDATE_PID_FILE), UPDATE_ARGS) !== undefined) {
    return {
      ok: false,
      version: o.version,
      error: { code: "update-running", message: "another update is in progress; see logs/daemon.log" },
    };
  }
  containerArch();
  mkdirSync(binDir(o.home), { recursive: true, mode: 0o700 });
  const { exec, args } = selfCommand([...UPDATE_ARGS, o.target, "--port", String(o.port), "--home", o.home]);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(exec, args, { cwd: homedir(), detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
  return { ok: true, version: o.version, status: "updating", target: o.target };
}

/** Downloads, checks and unpacks a version into `bin/<version>/`; a folder already there is replaced, since nothing vouches for it. */
async function fetchVersion(home: string, target: string, source: UpdateSource, note: (msg: string) => void): Promise<string> {
  const dest = join(binDir(home), target);
  const binary = join(dest, "trackwall-daemon");
  const work = join(binDir(home), `${target}.download`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true, mode: 0o700 });
  try {
    const name = linuxArchiveName(target, containerArch());
    const archive = join(work, name);
    note(`downloading ${source.url(target, name)}`);
    await download(source.url(target, name), archive, { maxBytes: ARCHIVE_MAX_BYTES, timeoutMs: DOWNLOAD_TIMEOUT_MS });
    await download(source.url(target, `${name}.sig`), `${archive}.sig`, { maxBytes: SIGNATURE_MAX_BYTES, timeoutMs: DOWNLOAD_TIMEOUT_MS });
    const comment = verifyMinisign({
      pubkey: source.pubkey,
      signature: readFileSync(`${archive}.sig`, "utf8"),
      data: readFileSync(archive),
    });
    const fields = trustedFields(comment);
    // The signature covers this comment: an archive of another version or architecture, signed too, is refused here.
    if (fields.file !== name || fields.version !== target) {
      throw new Error(`the signature is for ${fields.file ?? "?"} ${fields.version ?? "?"}, not ${name} ${target}`);
    }
    note(`the signature of ${name} checks out`);
    const unpacked = join(work, "unpacked");
    mkdirSync(unpacked, { mode: 0o700 });
    await extractTarGz(archive, unpacked, { env: process.env, timeoutMs: UNPACK_TIMEOUT_MS });
    const folder = join(unpacked, LINUX_ARCHIVE_FOLDER);
    const reported = await reportedVersion(join(folder, "trackwall-daemon"));
    if (reported !== target) throw new Error(`the unpacked binary reports version ${reported}, not ${target}`);
    rmSync(dest, { recursive: true, force: true });
    renameSync(folder, dest);
    return binary;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function reportedVersion(binary: string): Promise<string> {
  const { stdout } = await runProgram(binary, ["--version"], { label: `${binary} --version`, env: process.env, timeoutMs: 30_000 });
  return stdout.toString("utf8").trim();
}

async function waitUntil(check: () => Promise<boolean> | boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return check();
}

/**
 * Stops the daemon and its supervisor gracefully: the supervisor passes the signal on, and ends once the daemon has. A
 * daemon without a supervisor is signalled only when it answers for the state directory, so a stale `daemon.json` whose
 * PID now belongs to another process is not. Stopped means both gone and the port free (§1.3).
 */
async function stopRunning(home: string, port: number): Promise<void> {
  const supervisor = runningSupervisor(home);
  const daemon = (await probeRunningDaemon(home))?.file;
  const pid = supervisor ?? daemon?.pid;
  try {
    if (pid !== undefined) process.kill(pid, "SIGTERM");
  } catch (err) {
    // Gone between the look and the signal: that is the stop asked for.
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
  const stopped = await waitUntil(
    async () => runningSupervisor(home) === undefined && (daemon === undefined || !isAlive(daemon.pid)) && (await portFree(port)),
    STOP_TIMEOUT_MS,
  );
  if (!stopped) throw new Error(`the running daemon did not stop and free port ${port} within a minute`);
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/** Starts `binary`'s supervised daemon and waits until it answers as `version`; a start that reports a failure ends the wait. */
async function startAndWait(o: { home: string; port: number; binary: string; prefix: string[]; version: string }): Promise<boolean> {
  const { stdout } = await runProgram(
    o.binary,
    [...o.prefix, CONTAINER_COMMAND, CONTAINER_START, "--port", String(o.port), "--home", o.home],
    {
      label: "trackwall-container start",
      env: process.env,
      timeoutMs: 30_000,
      okExitCodes: [1, 2],
    },
  );
  const started = parseStartResult(stdout.toString("utf8"));
  if (started === undefined || !started.ok) return false;
  return waitUntil(async () => (await probeRunningDaemon(o.home))?.version === o.version, ANSWER_TIMEOUT_MS);
}

function parseStartResult(out: string): ContainerStartResult | undefined {
  try {
    const parsed = ContainerStartResult.safeParse(JSON.parse(out));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Every version folder in `bin/` but the ones to keep, with what an interrupted update left. */
function prune(home: string, keep: readonly (string | undefined)[]): void {
  for (const entry of readdirSync(binDir(home), { withFileTypes: true })) {
    if (entry.isDirectory() && !keep.includes(entry.name)) rmSync(join(binDir(home), entry.name), { recursive: true, force: true });
  }
}

export interface ApplyUpdateOptions {
  home: string;
  port: number;
  target: string;
  /** The version this process runs, and how to run it: a rollback goes back to it. */
  self: { version: string; command: { exec: string; args: string[] } };
  source: UpdateSource;
  note: (msg: string) => void;
}
export type UpdateOutcome = "updated" | "rolled-back" | "failed";

/** The background process of `trackwall-container update`, one at a time per state directory. */
export async function applyUpdate(o: ApplyUpdateOptions): Promise<UpdateOutcome> {
  const lock = join(binDir(o.home), UPDATE_PID_FILE);
  if (!claimPidFile(lock, UPDATE_ARGS)) {
    o.note("another update is in progress");
    return "failed";
  }
  try {
    return await switchVersion(o);
  } finally {
    releasePidFile(lock);
  }
}

async function switchVersion(o: ApplyUpdateOptions): Promise<UpdateOutcome> {
  const previous = currentVersion(o.home);
  let binary: string;
  try {
    binary = await fetchVersion(o.home, o.target, o.source, o.note);
  } catch (err) {
    o.note(`the update to ${o.target} failed, ${o.self.version} stays: ${messageOf(err)}`);
    return "failed";
  }
  // From the first signal on, every way out ends in a start: of the new version, or of this one.
  o.note(`stopping ${o.self.version} to start ${o.target}`);
  let started = false;
  try {
    await stopRunning(o.home, o.port);
    setCurrent(o.home, o.target);
    started = await startAndWait({ home: o.home, port: o.port, binary, prefix: [], version: o.target });
    if (!started) o.note(`${o.target} did not answer within a minute; going back to ${o.self.version}`);
  } catch (err) {
    o.note(`${o.target} did not start (${messageOf(err)}); going back to ${o.self.version}`);
  }
  if (!started) return rollBack(o, previous);
  o.note(`updated to ${o.target}`);
  try {
    prune(o.home, [o.target, previous]);
  } catch (err) {
    o.note(`old versions in bin/ stay: ${messageOf(err)}`);
  }
  return "updated";
}

/** Whatever the new version left running goes, and the version this process runs comes back. */
async function rollBack(o: ApplyUpdateOptions, previous: string | undefined): Promise<UpdateOutcome> {
  try {
    await stopRunning(o.home, o.port);
  } catch (err) {
    o.note(`what ${o.target} started may still be running: ${messageOf(err)}`);
  }
  try {
    setCurrent(o.home, previous);
  } catch (err) {
    o.note(`bin/current could not go back to ${previous ?? "the Feature's version"}: ${messageOf(err)}`);
  }
  const { exec, args } = o.self.command;
  const back = await startAndWait({ home: o.home, port: o.port, binary: exec, prefix: args, version: o.self.version }).catch(() => false);
  o.note(back ? `back on ${o.self.version}` : `${o.self.version} did not answer either; run trackwall-container start`);
  return "rolled-back";
}
