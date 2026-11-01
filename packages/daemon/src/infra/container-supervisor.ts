import { type ChildProcess, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONTAINER_COMMAND, SUPERVISE_COMMAND } from "./args.ts";
import { isAlive, readDaemonFile } from "./discovery.ts";
import { selfCommand } from "./self-command.ts";

/**
 * Keeps the daemon running in a dev container (ADR-164): `trackwall-container start` starts this supervisor in the
 * background, and it starts the daemon and starts it again after a crash, waiting longer after each crash in a row. It
 * stops supervising when the daemon ends on its own terms: exit code 0 (a stop through the API or a signal, or another
 * daemon of the same version already running, which then runs unsupervised and the log says so) or 3 (another version
 * running, which a restart cannot change). One supervisor per state directory, recorded in `container-supervisor.pid`.
 * The daemon's output goes to `logs/daemon.log`, which the daemon itself never reads.
 */

const PID_FILE = "container-supervisor.pid";
export const DAEMON_LOG = join("logs", "daemon.log");
/** Checked before each daemon start: above this size the log moves to `daemon.log.1`. */
const DAEMON_LOG_MAX_BYTES = 5 * 1024 * 1024;
/** Exit codes after which the daemon is not started again (main.ts: a stop or a daemon already running; another version). */
const FINAL_EXIT_CODES: readonly number[] = [0, 3];
/** A daemon that ran this long was healthy: its crash starts the waits from the shortest again. */
const HEALTHY_RUN_MS = 60_000;
/** After this many crashes in a row, each before `HEALTHY_RUN_MS`, the supervisor gives up and says so in the log. */
const MAX_CRASHES_IN_A_ROW = 10;
/** Signals to the supervisor go to the daemon, whose graceful stop then ends the supervisor too. */
const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];

/** The wait before the next start after `crashes` crashes in a row: 1 s, doubling, at most a minute. */
export function restartDelayMs(crashes: number): number {
  return Math.min(1000 * 2 ** Math.max(0, crashes - 1), 60_000);
}

export function supervisorPidFile(home: string): string {
  return join(home, PID_FILE);
}

function readPid(file: string): number | undefined {
  try {
    const pid = Number(readFileSync(file, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Whether `pid` is a supervisor, recognised by its command line where `/proc` has it (a dev container always does). */
function isSupervisor(pid: number): boolean {
  if (!existsSync("/proc")) return isAlive(pid);
  try {
    // A PID from a previous container start can belong to any process now: only one running this subcommand counts.
    const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    return args.includes(SUPERVISE_COMMAND) && args.includes(CONTAINER_COMMAND);
  } catch {
    return false;
  }
}

/** The PID of the supervisor of this state directory when one is running. */
export function runningSupervisor(home: string): number | undefined {
  const pid = readPid(supervisorPidFile(home));
  return pid !== undefined && isSupervisor(pid) ? pid : undefined;
}

/**
 * Claims the state directory for this supervisor, or returns false when another live one holds it. The PID file appears
 * with its content at once (written aside, then linked into place, which fails when the file exists), so a reader never
 * sees it empty; a file left by a supervisor that is gone is removed only while it still names that one.
 */
function claim(home: string): boolean {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = supervisorPidFile(home);
  const aside = `${file}.${process.pid}`;
  writeFileSync(aside, String(process.pid), { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(aside, file);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      const holder = readPid(file);
      if (holder !== undefined && isSupervisor(holder)) return false;
      if (readPid(file) === holder) rmSync(file, { force: true });
    }
    return false;
  } finally {
    rmSync(aside, { force: true });
  }
}

function release(home: string): void {
  if (readPid(supervisorPidFile(home)) === process.pid) rmSync(supervisorPidFile(home), { force: true });
}

function rotateLog(path: string): void {
  try {
    if (statSync(path).size > DAEMON_LOG_MAX_BYTES) renameSync(path, `${path}.1`);
  } catch {
    // no log yet
  }
}

function appendNote(logPath: string, msg: string): void {
  const fd = openSync(logPath, "a", 0o600);
  try {
    writeSync(fd, `[supervisor] ${new Date().toISOString()} ${msg}\n`);
  } finally {
    closeSync(fd);
  }
}

/** Starts the daemon with its output appended to the log. */
function startDaemon(home: string, port: number, logPath: string): ChildProcess {
  rotateLog(logPath);
  const fd = openSync(logPath, "a", 0o600);
  try {
    const { exec, args } = selfCommand(["--port", String(port), "--home", home]);
    return spawn(exec, args, { cwd: homedir(), stdio: ["ignore", fd, fd] });
  } finally {
    closeSync(fd);
  }
}

/** The daemon's exit code, null after a signal or when it could not start. */
function exitOf(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    child.once("error", () => resolve(null));
    child.once("exit", (code) => resolve(code));
  });
}

/** A signal to the supervisor goes to the running daemon, whose graceful stop (code 0) then ends the supervisor. */
function forwardSignals(home: string, daemon: () => ChildProcess | undefined): void {
  for (const signal of FORWARDED_SIGNALS) {
    process.on(signal, () => {
      const running = daemon();
      if (running?.exitCode === null) running.kill(signal);
      else {
        release(home);
        process.exit(0);
      }
    });
  }
}

/** Why the supervisor stops; code 0 with another live daemon in `daemon.json` means that one was already running. */
function finalExitNote(home: string, code: number, pid: number | undefined): string {
  const other = readDaemonFile(home);
  if (code === 0 && other !== undefined && other.pid !== pid && isAlive(other.pid)) {
    return `a daemon not started here already runs (pid ${other.pid}, port ${other.port}); it is not supervised`;
  }
  return `the daemon ended with code ${code}; not starting it again`;
}

export async function superviseDaemon(home: string, port: number): Promise<void> {
  const logPath = join(home, DAEMON_LOG);
  mkdirSync(join(home, "logs"), { recursive: true, mode: 0o700 });
  const note = (msg: string) => appendNote(logPath, msg);
  if (!claim(home)) {
    note(`another supervisor (pid ${runningSupervisor(home) ?? "?"}) already runs for ${home}`);
    return;
  }
  let daemon: ChildProcess | undefined;
  forwardSignals(home, () => daemon);
  try {
    let crashes = 0;
    for (;;) {
      const startedAt = Date.now();
      note(`starting the daemon on port ${port}`);
      daemon = startDaemon(home, port, logPath);
      const code = await exitOf(daemon);
      if (code !== null && FINAL_EXIT_CODES.includes(code)) {
        note(finalExitNote(home, code, daemon.pid));
        return;
      }
      crashes = Date.now() - startedAt >= HEALTHY_RUN_MS ? 1 : crashes + 1;
      if (crashes >= MAX_CRASHES_IN_A_ROW) {
        note(`the daemon crashed ${crashes} times in a row; giving up, run trackwall-container start again`);
        return;
      }
      const delay = restartDelayMs(crashes);
      note(`the daemon ended with ${code === null ? "a signal" : `code ${code}`}; starting it again in ${delay / 1000} s`);
      await new Promise((r) => setTimeout(r, delay));
    }
  } finally {
    release(home);
  }
}
