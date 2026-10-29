import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import type { JavaNavigationStatus } from "@trackwall/protocol";

/**
 * How a task's jdtls is doing (§4.4, ADR-124), read from its own log, `.metadata/.log` in its workspace folder, because
 * jdtls tells Copilot CLI it is ready also after an import that failed and then answers every question with nothing.
 * The log is Eclipse's: every start of jdtls opens a `!SESSION` line with its local time, and every entry is
 * `!ENTRY <plugin> <severity> <code> <time>` followed by `!MESSAGE <text>`, severity 4 being an error. Only the last start
 * counts, since a resume starts jdtls again on the same folder.
 */

/** Cold imports of a Spring Boot service took 51 to 82 s on a laptop; a warm start that hung never ended (ADR-99). */
const JDTLS_STALL_MS = 5 * 60 * 1000;
/** Eclipse rolls the log over at about 1 MB; the last start is near its end. */
const MAX_LOG_BYTES = 1024 * 1024;
const MAX_MESSAGE_CHARS = 300;
const ERROR_SEVERITY = "4";
/** jdtls's own line once the projects are imported and built, with or without errors before it. */
const INITIALIZED = /^Workspace initialized in \d+ms/;
const SESSION = /^!SESSION (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})/;

/** The log of jdtls started with `-data <dataDir>/workspace` (`javaLanguageServer`). */
export async function readJdtlsLog(dataDir: string): Promise<string | null> {
  const file = join(dataDir, "workspace", ".metadata", ".log");
  const size = await stat(file).then(
    (s) => s.size,
    () => null,
  );
  if (size === null) return null;
  const handle = await open(file, "r");
  try {
    const length = Math.min(size, MAX_LOG_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

export function jdtlsStatus(log: string | null, now: Date, stallMs = JDTLS_STALL_MS): JavaNavigationStatus {
  const lines = (log ?? "").split(/\r?\n/);
  const start = lines.findLastIndex((line) => SESSION.test(line));
  if (start === -1) return { kind: "starting" };
  const run = lines.slice(start);
  const error = firstErrorMessage(run);
  if (error !== null) return { kind: "failed", message: error };
  if (run.some((line) => INITIALIZED.test(messageOf(line) ?? ""))) return { kind: "ready" };
  const since = sessionTime(run[0] ?? "");
  if (since === null) return { kind: "starting" };
  const kind = now.getTime() - since.getTime() > stallMs ? "stalled" : "importing";
  return { kind, since: since.toISOString() };
}

/** The message of the first error entry: the `!MESSAGE` line after an `!ENTRY` of severity 4. */
function firstErrorMessage(run: readonly string[]): string | null {
  for (let i = 0; i < run.length; i++) {
    const entry = (run[i] ?? "").split(" ");
    if (entry[0] !== "!ENTRY" && entry[0] !== "!SUBENTRY") continue;
    // `!SUBENTRY` has its depth before the plugin.
    const severity = entry[0] === "!ENTRY" ? entry[2] : entry[3];
    if (severity !== ERROR_SEVERITY) continue;
    const message = messageOf(run[i + 1] ?? "");
    if (message !== null && message !== "") return cut(message);
  }
  return null;
}

function messageOf(line: string): string | null {
  return line.startsWith("!MESSAGE ") ? line.slice("!MESSAGE ".length).trim() : null;
}

/** The `!SESSION` line's time is the computer's local time. */
function sessionTime(line: string): Date | null {
  const m = SESSION.exec(line);
  if (m === null) return null;
  const [year, month, day, hour, minute, second, ms] = m.slice(1).map(Number);
  if (year === undefined || month === undefined || day === undefined) return null;
  return new Date(year, month - 1, day, hour ?? 0, minute ?? 0, second ?? 0, ms ?? 0);
}

function cut(text: string): string {
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS - 1)}…` : text;
}
