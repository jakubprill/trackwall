import type { LogLevel, LogRecord } from "@trackwall/protocol";

/**
 * The filters of `tail` and `get_errors` (§4.2): text a line contains, without regard to case, and a lowest level. They
 * narrow what the buffer already holds, so an agent reads the lines it looks for instead of a page of noise.
 */

/**
 * Whether `text` holds `contains` without regard to case; everything without `contains`. Plain `toLowerCase` on purpose:
 * locale-independent, and what log lines hold (class names, paths, ids) folds the same; `ß` against `SS` does not match.
 */
export function containsText(contains: string | undefined): (text: string) => boolean {
  if (contains === undefined) return () => true;
  const wanted = contains.toLowerCase();
  return (text) => text.toLowerCase().includes(wanted);
}

/** Whether a record is at `minLevel` or above (`trace` < `debug` < `info` < `warn` < `error`); every record without it. */
export function atLeast(minLevel: LogLevel | undefined): (record: LogRecord) => boolean {
  if (minLevel === undefined) return () => true;
  const lowest = LEVEL_RANK[minLevel];
  return (record) => LEVEL_RANK[record.level] >= lowest;
}

const LEVEL_RANK: Record<LogLevel, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };
