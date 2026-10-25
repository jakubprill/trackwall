import { LOG_BUFFER_RECORDS, type LogLevel, type LogRecord, type LogTail } from "@trackwall/protocol";

/**
 * A mise task's log in the UI (§4.2): records from successive `logs/tail` responses joined into one list, no longer than
 * the source's buffer in the daemon, and the line colour from the record's level.
 */

/** When the daemon reports `dropped`, the list starts over: there is a gap between the old and the new records. */
export function mergeTail(shown: LogRecord[], page: LogTail): LogRecord[] {
  if (!page.dropped && page.records.length === 0) return shown;
  const merged = page.dropped ? page.records : [...shown, ...page.records];
  return merged.slice(-LOG_BUFFER_RECORDS);
}

/** A tone only for what needs attention; details (`debug`, `trace`) dimmed, the rest plain text. */
export function logLevelClass(level: LogLevel): string {
  if (level === "error") return "text-destructive";
  if (level === "warn") return "text-warning";
  if (level === "debug" || level === "trace") return "text-muted-foreground";
  return "";
}

/** A record starts a new run when the previous one comes from another (a source has records of many runs). */
export function startsRun(records: readonly LogRecord[], index: number): boolean {
  const previous = records[index - 1];
  return previous !== undefined && previous.runId !== records[index]?.runId;
}
