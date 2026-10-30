import { type LogLevel, LogLevel as LogLevels, type LogRecord } from "@trackwall/protocol";

/**
 * The filters of `tail` and `get_errors` (§4.2): text a line contains, without regard to case, and a lowest level. They
 * narrow what the buffer already holds, so an agent reads the lines it looks for instead of a page of noise.
 */

/** Whether `text` holds `contains` without regard to case; everything without `contains`. */
export function containsText(contains: string | undefined): (text: string) => boolean {
  if (contains === undefined) return () => true;
  const wanted = contains.toLowerCase();
  return (text) => text.toLowerCase().includes(wanted);
}

/** Whether a record is at `minLevel` or above (`trace` < `debug` < `info` < `warn` < `error`); every record without it. */
export function atLeast(minLevel: LogLevel | undefined): (record: LogRecord) => boolean {
  if (minLevel === undefined) return () => true;
  const lowest = LogLevels.options.indexOf(minLevel);
  return (record) => LogLevels.options.indexOf(record.level) >= lowest;
}
