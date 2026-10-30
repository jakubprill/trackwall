import { LOG_ERROR_LINES, type LogError, type LogErrorLevel, type LogRecord, type LogSource } from "@trackwall/protocol";
import { type ErrorBlock, errorBlocks, STACK_FRAME } from "./error-blocks.ts";
import { containsText } from "./log-filter.ts";
import { shorten } from "./run-output.ts";

/**
 * Errors of several sources as entries for the agent (§4.2, ADR-42): blocks from `errorBlocks`, the same error of one
 * source merged into one entry with a count, most recent first, with lines trimmed to fit the agent's context.
 */

/** How many leading frames of each stack trace stay; the rest is usually framework internals, and the cause has its own `Caused by:`. */
const FRAMES_SHOWN = 10;
/** An error line has a limit: a JSON record with the stack trace in one field has up to 16 KB. */
const LINE_CHARS = 4000;
/** How many lines of an error without an exception identify it (a compiler diagnostic, a Spring or Gradle report). */
const SIGNATURE_LINES = 20;

export interface SourceRecords {
  readonly source: LogSource;
  /** Source key, the same as in the `logs` module; the same errors are merged only within one source. */
  readonly key: string;
  readonly records: readonly LogRecord[];
}

export interface ErrorsQuery {
  readonly minLevel: LogErrorLevel;
  /** Only errors with a record that contains this, without regard to case. */
  readonly contains: string | undefined;
  /** Skips errors whose first record has a `seq` not greater than the cursor. */
  readonly sinceSeq: number | undefined;
  readonly limit: number;
}

interface Occurrences {
  readonly source: LogSource;
  latest: ErrorBlock;
  readonly firstTs: string;
  count: number;
}

export function collectErrors(
  sources: readonly SourceRecords[],
  { minLevel, contains, sinceSeq, limit }: ErrorsQuery,
): { errors: LogError[]; truncated: boolean } {
  const found = new Map<string, Occurrences>();
  const matches = containsText(contains);
  for (const { source, key, records } of sources) {
    for (const block of errorBlocks(records, minLevel)) {
      if (sinceSeq !== undefined && block.first.seq <= sinceSeq) continue;
      if (!block.entries.some((entry) => matches(entry.record.msg))) continue;
      const id = `${key}\0${signature(block)}`;
      const seen = found.get(id);
      if (seen) {
        seen.latest = block;
        seen.count += 1;
      } else found.set(id, { source, latest: block, firstTs: block.first.ts, count: 1 });
    }
  }
  const newestFirst = [...found.values()].sort((a, b) => b.latest.first.seq - a.latest.first.seq);
  return { errors: newestFirst.slice(0, limit).map(logError), truncated: newestFirst.length > limit };
}

function logError({ source, latest, firstTs, count }: Occurrences): LogError {
  const { runId, stream, seq, ts } = latest.first;
  const { lines, omittedLines } = shownLines(latest);
  return { source, runId, stream, level: latest.level, exception: latest.exception, lines, omittedLines, seq, ts, firstTs, count };
}

/**
 * Lines for the agent: the first `FRAMES_SHOWN` frames of each run of stack frames, one line with the count in place
 * of the rest, then at most `LOG_ERROR_LINES` lines. Frames are recognised without the mise task prefix, but shown as
 * they are in the log.
 */
function shownLines(block: ErrorBlock): { lines: string[]; omittedLines: number } {
  const lines: string[] = [];
  let shownFromLog = 0;
  const show = (line: string, fromLog: boolean) => {
    if (lines.length >= LOG_ERROR_LINES) return;
    lines.push(line);
    if (fromLog) shownFromLog += 1;
  };
  let frames = 0;
  let skipped = 0;
  for (const { record, line } of block.entries) {
    const frame = STACK_FRAME.test(line);
    frames = frame ? frames + 1 : 0;
    if (frame && frames > FRAMES_SHOWN) {
      skipped += 1;
      continue;
    }
    if (skipped > 0) show(`\t… ${skipped} frames omitted`, false);
    skipped = 0;
    show(shorten(record.msg, LINE_CHARS), true);
  }
  if (skipped > 0) show(`\t… ${skipped} frames omitted`, false);
  return { lines, omittedLines: block.entries.length - shownFromLog };
}

/**
 * What makes errors the same: the exception and the first frame, or, without an exception, the first lines. Ids,
 * numbers and bracketed parts (thread names, which Spring cuts to 15 characters from the left, trace ids) differ
 * between occurrences of the same error and are replaced; file locations (`Orders.java:12`, `a.ts(3,5)`,
 * `Foo.java:[10,5]`) tell different compiler errors apart and stay.
 */
function signature(block: ErrorBlock): string {
  const lines = block.entries.map((e) => e.line);
  const text =
    block.exception === null
      ? lines.slice(0, SIGNATURE_LINES).join("\n")
      : `${block.exception}\n${lines.find((l) => STACK_FRAME.test(l))?.trim() ?? ""}`;
  return text.replace(VOLATILE, (match, location: string | undefined) => location ?? (match.startsWith("[") ? "[]" : "0"));
}

const VOLATILE =
  /(\.[A-Za-z]\w*(?::\[\d+,\d+\]|:\d+(?::\d+)?|\(\d+,\d+\)))|\[[^\]\n]*\]|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b[0-9a-f]{8,}\b|0x[0-9a-f]+|\d+/gi;
