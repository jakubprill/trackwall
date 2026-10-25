import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { DAEMON_FILE, DaemonFile, HealthResult } from "@trackwall/protocol";
import { writeFileAtomic } from "./atomic-write.ts";
import { loopbackRequest } from "./loopback.ts";

/** Discovering the daemon through `daemon.json` (§5.1). */

const LOCK_FILE = "daemon.lock";
/**
 * After this time the start lock counts as abandoned, even if the PID from the file is alive (PID reuse).
 * The critical section lasts milliseconds, and the limit must be shorter than the wait for the lock.
 */
const LOCK_STALE_MS = 10_000;
/** A lock file without a PID younger than this is being written right now by another starting daemon. */
const LOCK_WRITE_GRACE_MS = 2_000;

export function daemonFilePath(home: string): string {
  return join(home, DAEMON_FILE);
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function readDaemonFile(home: string): DaemonFile | undefined {
  try {
    const parsed = DaemonFile.safeParse(JSON.parse(readFileSync(daemonFilePath(home), "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** An atomic write (temporary file + rename), with owner-only permissions where the system has them. */
export function writeDaemonFile(home: string, file: DaemonFile): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileAtomic(daemonFilePath(home), `${JSON.stringify(file, null, 2)}\n`, 0o600);
}

/** Removes `daemon.json` only while it still describes this process (does not delete a successor's file). */
export function removeDaemonFile(home: string, pid: number): void {
  const current = readDaemonFile(home);
  if (current?.pid === pid) rmSync(daemonFilePath(home), { force: true });
}

/** The running daemon's version from `daemon.json`, or `undefined` when nobody answers. */
export async function probeRunningDaemon(home: string, timeoutMs = 1500): Promise<{ file: DaemonFile; version: string } | undefined> {
  const file = readDaemonFile(home);
  if (!file) return undefined;
  try {
    const res = await loopbackRequest(file.port, "/api/health", { timeoutMs });
    const body = HealthResult.safeParse(JSON.parse(res.body));
    if (!body.success || !body.data.ok) return undefined;
    return { file, version: body.data.data.version };
  } catch {
    return undefined;
  }
}

/**
 * The start's critical section: checking whether a daemon is already running, and the new one writing `daemon.json`.
 * Without it two simultaneous starts (a double click, Tauri + `--ui`) leave two daemons, one of them invisible.
 *
 * Taking over an abandoned lock is not atomic (Node has no flock), so two starts that both decided at once that
 * it was abandoned can both enter the section. `watchDaemonFile` in the daemon closes this rare case.
 */
export async function withStartLock<T>(home: string, fn: () => Promise<T>, timeoutMs = 15_000): Promise<T> {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const lock = join(home, LOCK_FILE);
  const deadline = Date.now() + timeoutMs;
  while (!tryCreateLock(lock)) {
    if (isStaleLock(lock)) {
      rmSync(lock, { force: true });
      continue;
    }
    if (Date.now() > deadline) throw new Error(`startup lock ${lock} held for longer than ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    return await fn();
  } finally {
    releaseLock(lock);
  }
}

/** `false` when the lock already exists; any other file system error propagates. */
function tryCreateLock(lock: string): boolean {
  let fd: number;
  try {
    fd = openSync(lock, "wx", 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  try {
    writeSync(fd, String(process.pid));
  } finally {
    closeSync(fd);
  }
  return true;
}

function releaseLock(lock: string): void {
  try {
    if (readFileSync(lock, "utf8") === String(process.pid)) rmSync(lock, { force: true });
  } catch {
    // someone decided the lock was abandoned and removed it
  }
}

function isStaleLock(lock: string): boolean {
  let holder: number;
  let ageMs: number;
  try {
    holder = Number(readFileSync(lock, "utf8"));
    ageMs = Date.now() - statSync(lock).mtimeMs;
  } catch {
    return false; // gone between attempts; the next iteration creates it
  }
  if (ageMs > LOCK_STALE_MS) return true;
  if (!Number.isInteger(holder) || holder <= 0) return ageMs > LOCK_WRITE_GRACE_MS;
  // Our own PID in someone else's lock: a previous incarnation of this process (`bun --watch` restarts through execve).
  if (holder === process.pid) return true;
  return !isAlive(holder);
}

/**
 * Makes sure that `daemon.json` describes this process. When it points to another live daemon, this process is
 * invisible to clients and is to end; when the file has disappeared, it is written again.
 */
export function watchDaemonFile(home: string, self: DaemonFile, onSuperseded: (by: DaemonFile) => void, intervalMs = 2000): () => void {
  const timer = setInterval(() => {
    const current = readDaemonFile(home);
    if (current === undefined) writeDaemonFile(home, self);
    else if (current.pid !== self.pid && isAlive(current.pid)) onSuperseded(current);
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
