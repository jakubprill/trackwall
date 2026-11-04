import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONTAINER_COMMAND, containerProxyPort, SUPERVISE_COMMAND } from "./args.ts";
import { appendNote } from "./container-log.ts";
import { isAlive, readDaemonFile } from "./discovery.ts";
import { claimPidFile, pidFileHolder, releasePidFile } from "./pid-file.ts";
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

/** The supervisor's command line, by which its PID file's holder is recognised. */
const SUPERVISOR_ARGS = [CONTAINER_COMMAND, SUPERVISE_COMMAND];

/** The PID of the supervisor of this state directory when one is running. */
export function runningSupervisor(home: string): number | undefined {
  return pidFileHolder(supervisorPidFile(home), SUPERVISOR_ARGS);
}

function claim(home: string): boolean {
  return claimPidFile(supervisorPidFile(home), SUPERVISOR_ARGS);
}

function release(home: string): void {
  releasePidFile(supervisorPidFile(home));
}

function rotateLog(path: string): void {
  try {
    if (statSync(path).size > DAEMON_LOG_MAX_BYTES) renameSync(path, `${path}.1`);
  } catch {
    // no log yet
  }
}

/** Starts the daemon with its output appended to the log. */
function startDaemon(home: string, port: number, logPath: string): ChildProcess {
  rotateLog(logPath);
  const fd = openSync(logPath, "a", 0o600);
  try {
    const proxyPort = containerProxyPort(port);
    const proxy = proxyPort === null ? [] : ["--proxy-port", String(proxyPort)];
    const { exec, args } = selfCommand(["--port", String(port), ...proxy, "--home", home]);
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

/** A signal to the supervisor goes to the running daemon and ends the supervisor once the daemon has ended. */
function forwardSignals(home: string, daemon: () => ChildProcess | undefined, stop: { requested: boolean }): void {
  for (const signal of FORWARDED_SIGNALS) {
    process.on(signal, () => {
      stop.requested = true;
      const running = daemon();
      if (running !== undefined && running.exitCode === null && running.signalCode === null && running.pid !== undefined) {
        running.kill(signal);
      } else {
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

/** What follows one run of the daemon: stop supervising (with why), or start it again after a wait. */
export type AfterExit =
  | { kind: "stop"; why: string }
  | { kind: "final"; code: number }
  | { kind: "restart"; crashes: number; delayMs: number };

export function afterExit(run: { code: number | null; ranMs: number; stopRequested: boolean }, crashesBefore: number): AfterExit {
  const ended = run.code === null ? "a signal" : `code ${run.code}`;
  if (run.stopRequested) return { kind: "stop", why: `stopped by a signal; the daemon ended with ${ended}` };
  if (run.code !== null && FINAL_EXIT_CODES.includes(run.code)) return { kind: "final", code: run.code };
  const crashes = run.ranMs >= HEALTHY_RUN_MS ? 1 : crashesBefore + 1;
  if (crashes >= MAX_CRASHES_IN_A_ROW) {
    return { kind: "stop", why: `the daemon crashed ${crashes} times in a row; giving up, run trackwall-container start again` };
  }
  return { kind: "restart", crashes, delayMs: restartDelayMs(crashes) };
}

export async function superviseDaemon(home: string, port: number): Promise<void> {
  const logPath = join(home, DAEMON_LOG);
  mkdirSync(join(home, "logs"), { recursive: true, mode: 0o700 });
  const note = (msg: string) => appendNote(logPath, "supervisor", msg);
  if (!claim(home)) {
    note(`another supervisor (pid ${runningSupervisor(home) ?? "?"}) already runs for ${home}`);
    return;
  }
  let daemon: ChildProcess | undefined;
  const stop = { requested: false };
  forwardSignals(home, () => daemon, stop);
  try {
    let crashes = 0;
    for (;;) {
      const startedAt = Date.now();
      note(`starting the daemon on port ${port}`);
      daemon = startDaemon(home, port, logPath);
      const code = await exitOf(daemon);
      const next = afterExit({ code, ranMs: Date.now() - startedAt, stopRequested: stop.requested }, crashes);
      if (next.kind === "stop") return note(next.why);
      if (next.kind === "final") return note(finalExitNote(home, next.code, daemon.pid));
      crashes = next.crashes;
      note(`the daemon ended with ${code === null ? "a signal" : `code ${code}`}; starting it again in ${next.delayMs / 1000} s`);
      await new Promise((r) => setTimeout(r, next.delayMs));
    }
  } finally {
    release(home);
  }
}
