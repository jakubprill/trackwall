import type { LogErrorLevel, LogRecord } from "@trackwall/protocol";
import { withoutTaskPrefix } from "./log-level.ts";

/**
 * Errors in the records of one source (§4.2, ADR-42): a record at the level threshold or an exception header starts
 * a block, and the lines that belong to it extend it: Java and Node stack frames, `Caused by:`, an exception header
 * under a logger's `ERROR` line, indented lines (context of javac, tsc and Vite diagnostics), blank lines and further
 * lines with the same level tag and no timestamp (Maven `[ERROR]`, `npm error`). The Spring "APPLICATION FAILED TO
 * START" report and the Gradle `FAILURE:` report are regions that last until their end, because their paragraphs are
 * not indented. Only records of the same run and stream extend a block: stdout and stderr interleave arbitrarily.
 */

/** A Java (`\tat a.B.c(B.java:1)`, `... 12 more`) or Node (`    at fn (file.js:1:2)`) stack frame. */
export const STACK_FRAME = /^\s+at\s|^\s*\.\.\. \d+ (more|common frames omitted)\s*$/;
/** `Caused by:` and `Suppressed:` in a Java stack trace; group 1 is the cause's exception. */
const CAUSE = /^\s*(?:Caused by|Suppressed): (.+)$/;
/**
 * An exception header: a class name (with its package) ending in `Exception`, `Error` or `Throwable`, alone or with
 * `: message` (`java.lang.IllegalStateException: …`, `TypeError: …`, `AssertionError [ERR_ASSERTION]: …`,
 * `Exception in thread "main" …`). Group 1 is the exception without the preamble.
 */
const EXCEPTION =
  /^(?:Exception in thread "[^"]*" |Uncaught )?((?:[a-z_$][\w$]*\.)*(?:[A-Z][\w$]*)?(?:Exception|Error|Throwable)(?: \[[A-Z_]+\])?(?::\s.*)?)$/;
/** A level tag at the start of a line without a timestamp, repeated on every line of one message. */
const LEVEL_TAG = /^(?:\[(?:ERROR|FATAL|WARNING|WARN)\]|npm (?:ERR!|error|warn))/;
const INDENTED = /^\s+\S/;
const BLANK = /^\s*$/;
/** A longer block is closed: a region without its end (process killed mid-report) does not swallow the rest of the log. */
const MAX_BLOCK_RECORDS = 500;

interface Region {
  readonly opens: RegExp;
  /** `line` closes the region without becoming part of it. */
  endsBefore(line: string, lines: readonly string[]): boolean;
  /** `line` belongs to the region and closes it. */
  endsWith(line: string): boolean;
}

const REGIONS: readonly Region[] = [
  {
    // Spring Boot: a frame of asterisks, the header, `Description:` and `Action:` paragraphs; it ends at the blank line after the action.
    opens: /^\*{10,}\s*$|^APPLICATION FAILED TO START\s*$/,
    endsBefore: (line, lines) => {
      const action = lines.findLastIndex((l) => /^Action:\s*$/.test(l));
      return BLANK.test(line) && action !== -1 && lines.slice(action + 1).some((l) => !BLANK.test(l));
    },
    endsWith: () => false,
  },
  {
    // Gradle: `FAILURE: Build failed…`, the `* What went wrong:` and `* Try:` sections, and `BUILD FAILED in 3s` at the end.
    opens: /^FAILURE: /,
    endsBefore: () => false,
    endsWith: (line) => /^BUILD FAILED\b/.test(line),
  },
];

export interface ErrorBlock {
  readonly records: readonly LogRecord[];
  readonly level: LogErrorLevel;
  /** The last `Caused by:` or the first exception header in the block. */
  readonly exception: string | null;
}

interface OpenBlock {
  readonly records: LogRecord[];
  /** Lines without the mise task prefix, parallel to `records`. */
  readonly lines: string[];
  readonly level: LogErrorLevel;
  readonly tag: string | null;
  region: Region | null;
  /** The block already has stack frames: the next exception header is a new error, not the exception under a logger line. */
  frames: boolean;
}

/** Error blocks in the records of one source, ordered by their first record. */
export function errorBlocks(records: readonly LogRecord[], minLevel: LogErrorLevel): ErrorBlock[] {
  const blocks: ErrorBlock[] = [];
  const open = new Map<string, OpenBlock>();
  for (const record of records) {
    const key = `${record.runId}\0${record.stream}`;
    const line = withoutTaskPrefix(record.msg);
    const current = open.get(key);
    if (current && continues(current, line, record)) {
      add(current, record, line);
      if (current.region?.endsWith(line)) {
        blocks.push(closed(current));
        open.delete(key);
      }
      continue;
    }
    if (current) blocks.push(closed(current));
    open.delete(key);
    const started = start(record, line, minLevel);
    if (started) open.set(key, started);
  }
  for (const block of open.values()) blocks.push(closed(block));
  return blocks.sort((a, b) => firstRecord(a).seq - firstRecord(b).seq);
}

function start(record: LogRecord, line: string, minLevel: LogErrorLevel): OpenBlock | null {
  const region = REGIONS.find((r) => r.opens.test(line)) ?? null;
  const exception = EXCEPTION.test(line) || CAUSE.test(line);
  const level = record.level === "error" || region || exception ? "error" : record.level === "warn" && minLevel === "warn" ? "warn" : null;
  if (!level) return null;
  return { records: [record], lines: [line], level, tag: LEVEL_TAG.exec(line)?.[0] ?? null, region, frames: STACK_FRAME.test(line) };
}

function continues(block: OpenBlock, line: string, record: LogRecord): boolean {
  if (block.records.length >= MAX_BLOCK_RECORDS) return false;
  if (block.region) return !block.region.endsBefore(line, block.lines);
  if (REGIONS.some((r) => r.opens.test(line))) return true;
  if (STACK_FRAME.test(line) || CAUSE.test(line) || INDENTED.test(line) || BLANK.test(line)) return true;
  // The exception under a logger line, until there are frames; an `error` line under a warning is a new error.
  if (EXCEPTION.test(line)) return !block.frames && !(block.level === "warn" && record.level === "error");
  return block.tag !== null && LEVEL_TAG.exec(line)?.[0] === block.tag;
}

function add(block: OpenBlock, record: LogRecord, line: string): void {
  block.records.push(record);
  block.lines.push(line);
  block.region ??= REGIONS.find((r) => r.opens.test(line)) ?? null;
  if (STACK_FRAME.test(line)) block.frames = true;
}

/** The block without trailing blank lines (they belonged to it only in case it went on). */
function closed(block: OpenBlock): ErrorBlock {
  let end = block.lines.length;
  while (end > 1 && BLANK.test(block.lines[end - 1] ?? "")) end -= 1;
  const lines = block.lines.slice(0, end);
  return { records: block.records.slice(0, end), level: block.level, exception: exceptionOf(lines) };
}

function exceptionOf(lines: readonly string[]): string | null {
  const cause = lines.findLast((l) => CAUSE.test(l));
  if (cause !== undefined) return CAUSE.exec(cause)?.[1] ?? null;
  for (const line of lines) {
    const match = EXCEPTION.exec(line);
    if (match?.[1]) return match[1];
  }
  return null;
}

/** The record that started the block: a block always has at least this one. */
export function firstRecord(block: ErrorBlock): LogRecord {
  const record = block.records[0];
  if (!record) throw new Error("error block without records");
  return record;
}
