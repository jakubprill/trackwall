import { LOG_ERROR_LINES, type LogError, type LogErrorLevel, type LogRecord, type LogSource } from "@trackwall/protocol";
import { type ErrorBlock, errorBlocks, firstRecord as first, STACK_FRAME } from "./error-blocks.ts";
import { withoutTaskPrefix } from "./log-level.ts";

/**
 * Errors of several sources as entries for the agent (§4.2, ADR-42): blocks from `errorBlocks`, the same error of one
 * source merged into one entry with a count, most recent first, with lines trimmed to fit the agent's context.
 */

/** How many leading frames of each stack trace stay; the rest is usually framework internals, and the cause has its own `Caused by:`. */
const FRAMES_SHOWN = 10;
/** An error line has a limit: a JSON record with the stack trace in one field has up to 16 KB. */
const LINE_CHARS = 4000;

export interface SourceRecords {
  readonly source: LogSource;
  /** Source key, the same as in the `logs` module; the same errors are merged only within one source. */
  readonly key: string;
  readonly records: readonly LogRecord[];
}

export interface ErrorsQuery {
  readonly minLevel: LogErrorLevel;
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
  { minLevel, sinceSeq, limit }: ErrorsQuery,
): { errors: LogError[]; truncated: boolean } {
  const found = new Map<string, Occurrences>();
  for (const { source, key, records } of sources) {
    for (const block of errorBlocks(records, minLevel)) {
      if (sinceSeq !== undefined && first(block).seq <= sinceSeq) continue;
      const id = `${key}\0${signature(block)}`;
      const seen = found.get(id);
      if (seen) {
        seen.latest = block;
        seen.count += 1;
      } else found.set(id, { source, latest: block, firstTs: first(block).ts, count: 1 });
    }
  }
  const newestFirst = [...found.values()].sort((a, b) => first(b.latest).seq - first(a.latest).seq);
  return { errors: newestFirst.slice(0, limit).map(logError), truncated: newestFirst.length > limit };
}

function logError({ source, latest, firstTs, count }: Occurrences): LogError {
  const { runId, stream, seq, ts } = first(latest);
  const { lines, omittedLines } = shownLines(latest.records.map((r) => r.msg));
  return { source, runId, stream, level: latest.level, exception: latest.exception, lines, omittedLines, seq, ts, firstTs, count };
}

/**
 * Lines for the agent: the first `FRAMES_SHOWN` frames of each run of stack frames, one line with the count in place
 * of the rest, then at most `LOG_ERROR_LINES` lines.
 */
function shownLines(msgs: readonly string[]): { lines: string[]; omittedLines: number } {
  // `true` for a line from the log, `false` for the omitted-frames line (those frames are already counted as omitted).
  const lines: [string, boolean][] = [];
  let frames = 0;
  let skipped = 0;
  const flushSkipped = () => {
    if (skipped > 0) lines.push([`\t… ${skipped} frames omitted`, false]);
    skipped = 0;
  };
  for (const msg of msgs) {
    if (!STACK_FRAME.test(msg)) {
      flushSkipped();
      frames = 0;
    } else if (++frames > FRAMES_SHOWN) {
      skipped += 1;
      continue;
    }
    lines.push([msg.length > LINE_CHARS ? `${msg.slice(0, LINE_CHARS)}…` : msg, true]);
  }
  flushSkipped();
  const shown = lines.slice(0, LOG_ERROR_LINES);
  return { lines: shown.map(([line]) => line), omittedLines: msgs.length - shown.filter(([, fromLog]) => fromLog).length };
}

/**
 * The same error is the same first line and exception once ids and numbers are replaced: the time, PID, thread
 * (`nio-8080-exec-3`), request id or port differ between occurrences of the same error.
 */
function signature(block: ErrorBlock): string {
  const text = `${withoutTaskPrefix(first(block).msg)}\0${block.exception ?? ""}`;
  return text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>").replace(/0x[0-9a-f]+|\d+/gi, "0");
}
