import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isAlive } from "./discovery.ts";
import { selfCommand } from "./self-command.ts";

/**
 * Keeps the daemon running in a dev container (ADR-164): `trackwall-container start` starts this supervisor in the
 * background, and it starts the daemon and starts it again after a crash, waiting longer after each crash in a row. It
 * stops supervising when the daemon ends on its own terms: a stop through the API or a signal (exit code 0), or another
 * version already running (exit code 3, which a restart cannot change). One supervisor per state directory, recorded in
 * `container-supervisor.pid`. The daemon's output goes to `logs/daemon.log`, which the daemon itself never reads.
 */

const PID_FILE = "container-supervisor.pid";
/** The subcommand of `trackwall-daemon` behind `trackwall-container`. */
export const CONTAINER_COMMAND = "container";
/** The supervisor's own subcommand, also how its process is recognised in `/proc/<pid>/cmdline`. */
export const SUPERVISE_COMMAND = "supervise";
export const DAEMON_LOG = join("logs", "daemon.log");
/** Above this size the log moves to `daemon.log.1` before the next daemon start, so the two files stay under twice that. */
const DAEMON_LOG_MAX_BYTES = 5 * 1024 * 1024;
/** Exit codes after which the daemon is not started again (main.ts: a stop, another version running). */
const FINAL_EXIT_CODES: readonly number[] = [0, 3];
/** A daemon that ran this long was healthy: its crash starts the waits from the shortest again. */
const HEALTHY_RUN_MS = 60_000;
/** After this many crashes in a row, each before `HEALTHY_RUN_MS`, the supervisor gives up and says so in the log. */
const MAX_CRASHES_IN_A_ROW = 10;

/** The wait before the next start after `crashes` crashes in a row: 1 s, doubling, at most a minute. */
export function restartDelayMs(crashes: number): number {
  return Math.min(1000 * 2 ** Math.max(0, crashes - 1), 60_000);
}

export function supervisorPidFile(home: string): string {
  return join(home, PID_FILE);
}

/** The PID of the supervisor of this state directory when one is running, recognised by its command line. */
export function runningSupervisor(home: string): number | undefined {
  let pid: number;
  try {
    pid = Number(readFileSync(supervisorPidFile(home), "utf8").trim());
  } catch {
    return undefined;
  }
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (!existsSync("/proc")) return isAlive(pid) ? pid : undefined;
  try {
    // A PID from a previous container start can belong to any process now: only one running this subcommand counts.
    const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    return args.includes(SUPERVISE_COMMAND) && args.includes(CONTAINER_COMMAND) ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Claims the state directory for this supervisor, or returns false when another live one holds it. A PID file left by a
 * supervisor that is gone is taken over.
 */
function claim(home: string): boolean {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = supervisorPidFile(home);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (runningSupervisor(home) !== undefined) return false;
      rmSync(file, { force: true });
    }
  }
  return false;
}

function release(home: string): void {
  try {
    if (readFileSync(supervisorPidFile(home), "utf8").trim() === String(process.pid)) rmSync(supervisorPidFile(home), { force: true });
  } catch {
    // already gone
  }
}

function rotateLog(path: string): void {
  try {
    if (statSync(path).size > DAEMON_LOG_MAX_BYTES) renameSync(path, `${path}.1`);
  } catch {
    // no log yet
  }
}

/** Starts the daemon once with its output appended to the log, and resolves with its exit code (null after a signal). */
function runDaemonOnce(home: string, port: number, logPath: string): Promise<number | null> {
  rotateLog(logPath);
  const fd = openSync(logPath, "a", 0o600);
  const { exec, args } = selfCommand(["--port", String(port), "--home", home]);
  return new Promise((resolve) => {
    const child = spawn(exec, args, { cwd: homedir(), stdio: ["ignore", fd, fd] });
    closeSync(fd);
    child.on("error", () => resolve(null));
    child.on("exit", (code) => resolve(code));
  });
}

export async function superviseDaemon(home: string, port: number): Promise<void> {
  const logPath = join(home, DAEMON_LOG);
  mkdirSync(join(home, "logs"), { recursive: true, mode: 0o700 });
  const note = (msg: string) => {
    const fd = openSync(logPath, "a", 0o600);
    try {
      writeSync(fd, `[supervisor] ${new Date().toISOString()} ${msg}\n`);
    } finally {
      closeSync(fd);
    }
  };
  if (!claim(home)) return;
  const stop = () => {
    release(home);
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    let crashes = 0;
    for (;;) {
      const startedAt = Date.now();
      note(`starting the daemon on port ${port}`);
      const code = await runDaemonOnce(home, port, logPath);
      if (code !== null && FINAL_EXIT_CODES.includes(code)) {
        note(`the daemon ended with code ${code}; not starting it again`);
        return;
      }
      crashes = Date.now() - startedAt >= HEALTHY_RUN_MS ? 1 : crashes + 1;
      if (crashes > MAX_CRASHES_IN_A_ROW) {
        note(`the daemon crashed ${MAX_CRASHES_IN_A_ROW} times in a row; giving up, run trackwall-container start again`);
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
