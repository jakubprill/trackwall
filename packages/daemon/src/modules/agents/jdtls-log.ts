import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { JAVA_NAVIGATION_STALL_MS, type JavaNavigationStatus } from "@trackwall/protocol";

/**
 * How a task's jdtls is doing (§4.4, ADR-124), read from its own log, `.metadata/.log` in its workspace folder, because
 * jdtls tells Copilot CLI it is ready also after an import that failed and then answers every question with nothing.
 * The log is Eclipse's: every start of jdtls opens a `!SESSION` line with its local time, and every entry is
 * `!ENTRY <plugin> <severity> <code> <time>` followed by `!MESSAGE <text>`, severity 4 being an error. Only the last start
 * counts, since a resume starts jdtls again on the same folder, and only errors before the workspace is initialized:
 * later ones (a request that threw, a file that does not compile) leave the import as it was.
 */

/** Eclipse rolls the log over at about 1 MB; the last start is near its end. */
const MAX_LOG_BYTES = 1024 * 1024;
const MAX_MESSAGE_CHARS = 300;
const ERROR_SEVERITY = "4";
/** jdtls's own line once the projects are imported and built, with or without errors before it. */
const INITIALIZED = /^Workspace initialized in \d+ms/;
const SESSION = /^!SESSION (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})/;
/** The `!SESSION` time is jdtls's clock to the millisecond, the session's start the daemon's, a moment before it. */
const START_SLACK_MS = 5000;

/**
 * The log of jdtls started with `-data <dataDir>/workspace` (`javaLanguageServer`); `null` without one. The folder is
 * in the projects folder, which agents write, so anything but a regular file is no log, and it is opened without
 * waiting, so a pipe put in its place cannot hold the daemon.
 */
export async function readJdtlsLog(dataDir: string): Promise<string | null> {
  const file = join(dataDir, "workspace", ".metadata", ".log");
  try {
    if (!(await lstat(file)).isFile()) return null;
    const handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, MAX_LOG_BYTES);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    // Rolled over or held by jdtls on Windows between the calls: the next request reads it again.
    return null;
  }
}

/**
 * The state from the log at `now`. `startedAt` is when the task's running session started: a log whose last start is
 * older belongs to the run before, and jdtls of this one is still starting.
 */
export function jdtlsStatus(log: string | null, now: Date, startedAt: Date | null): JavaNavigationStatus {
  const lines = (log ?? "").split(/\r?\n/);
  const start = lines.findLastIndex((line) => SESSION.test(line));
  const since = start === -1 ? null : sessionTime(lines[start] ?? "");
  if (since === null || (startedAt !== null && since.getTime() < startedAt.getTime() - START_SLACK_MS)) return { kind: "starting" };
  const run = lines.slice(start);
  const initialized = run.findIndex((line) => INITIALIZED.test(messageOf(line) ?? ""));
  const error = firstErrorMessage(initialized === -1 ? run : run.slice(0, initialized));
  if (error !== null) return { kind: "failed", message: error };
  if (initialized !== -1) return { kind: "ready" };
  const kind = now.getTime() - since.getTime() > JAVA_NAVIGATION_STALL_MS ? "stalled" : "importing";
  return { kind, since: since.toISOString() };
}

/** The message of the first error entry: the `!MESSAGE` line after an `!ENTRY` or `!SUBENTRY` of severity 4. */
function firstErrorMessage(run: readonly string[]): string | null {
  for (let i = 0; i < run.length; i++) {
    const entry = (run[i] ?? "").split(" ");
    // `!SUBENTRY` has its depth before the plugin.
    const severity = entry[0] === "!ENTRY" ? entry[2] : entry[0] === "!SUBENTRY" ? entry[3] : undefined;
    if (severity !== ERROR_SEVERITY) continue;
    const message = messageOf(run[i + 1] ?? "");
    if (message) return cut(message);
  }
  return null;
}

function messageOf(line: string): string | null {
  return line.startsWith("!MESSAGE ") ? line.slice("!MESSAGE ".length).trim() : null;
}

/** The `!SESSION` line's time is the computer's local time, as a date-time without an offset is read. */
function sessionTime(line: string): Date | null {
  const m = SESSION.exec(line);
  return m === null ? null : new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}`);
}

function cut(text: string): string {
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS - 1)}…` : text;
}
