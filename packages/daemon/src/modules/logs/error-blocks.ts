import type { LogErrorLevel, LogRecord } from "@trackwall/protocol";
import { LEVEL_TAG, withoutTaskPrefix } from "./log-level.ts";

/**
 * Errors in the records of one source (§4.2, ADR-42): a record at the level threshold or an exception header starts
 * a block, and the lines that belong to it extend it: Java and Node stack frames, `Caused by:` and `Suppressed:`, an
 * exception header under a logger's `ERROR` line, indented lines (context of javac, tsc and Vite diagnostics), blank
 * lines, Node's `Require stack:` and further lines with the same level tag and no timestamp (Maven `[ERROR]`,
 * `npm error`). The Spring "APPLICATION FAILED TO START" report and the Gradle `FAILURE:` report are regions that last
 * until their end, because their paragraphs are not indented. Only records of the same run and stream extend a block:
 * stdout and stderr interleave arbitrarily.
 */

/** A Java (`\tat a.B.c(B.java:1)`) or Node (`    at fn (file.js:1:2)`) stack frame. */
export const STACK_FRAME = /^\s+at\s/;
/** The end of a Java stack trace that refers to the frames of the enclosing one (`... 12 more`). */
const FRAMES_TAIL = /^\s*\.\.\. \d+ (more|common frames omitted)\s*$/;
/** `Caused by:` in a Java stack trace; group 1 is the cause's exception. */
const CAUSE = /^\s*Caused by: (.+)$/;
/** `Suppressed:` in a Java stack trace: part of the error, but not its cause. */
const SUPPRESSED = /^\s*Suppressed: /;
/**
 * An exception header: a class name (with its package) ending in `Exception`, `Error` or `Throwable`, alone or with
 * `: message` (`java.lang.IllegalStateException: …`, `TypeError: …`, `AssertionError [ERR_ASSERTION]: …`,
 * `Exception in thread "main" …`). Group 1 is the exception without the preamble.
 */
const EXCEPTION =
  /^(?:Exception in thread "[^"]*" |Uncaught )?((?:[a-z_$][\w$]*\.)*(?:[A-Z][\w$]*)?(?:Exception|Error|Throwable)(?: \[[A-Z_]+\])?(?::\s.*)?)$/;
/** Node's list of modules after `Cannot find module` (`Require stack:`, `- /repo/index.js`). */
const REQUIRE_STACK = /^Require stack:\s*$|^- \S/;
/** The frame of asterisks around the Spring report header. */
const BANNER = /^\*{10,}\s*$/;
/** The start of a logger's next event: a date or a time at the start of the line. */
const TIMESTAMP = /^\[?(\d{4}-\d{2}-\d{2}[T ])?\d{2}:\d{2}:\d{2}/;
const INDENTED = /^\s+\S/;
const BLANK = /^\s*$/;
/** A longer block is closed: a region without its end (process killed mid-report) does not swallow the rest of the log. */
const MAX_BLOCK_RECORDS = 500;

interface Region {
  readonly opens: RegExp;
  /** A line that belongs to the region and closes it. */
  readonly closesWith: RegExp | null;
  /** The heading of the last section: the blank line after its first paragraph closes the region. */
  readonly lastSection: RegExp | null;
}

const REGIONS: readonly Region[] = [
  // Spring Boot: the header in a frame of asterisks, then `Description:` and, when the analysis has one, `Action:`.
  { opens: /^APPLICATION FAILED TO START\s*$/, closesWith: null, lastSection: /^Action:\s*$/ },
  // Gradle: `FAILURE: Build failed…`, the `* What went wrong:` and `* Try:` sections, and `BUILD FAILED in 3s` at the end.
  { opens: /^FAILURE: /, closesWith: /^BUILD FAILED\b/, lastSection: null },
];

/** Where an open region is: before its last section, at its heading, or in its first paragraph. */
type RegionPhase = "body" | "last-section" | "last-paragraph";

export interface ErrorBlock {
  /** The record that started the block. */
  readonly first: LogRecord;
  readonly records: readonly LogRecord[];
  /** Lines without the mise task prefix, parallel to `records`. */
  readonly lines: readonly string[];
  readonly level: LogErrorLevel;
  /** The last `Caused by:` or the first exception header in the block. */
  readonly exception: string | null;
}

interface OpenBlock {
  readonly records: LogRecord[];
  readonly lines: string[];
  readonly level: LogErrorLevel;
  readonly tag: string | null;
  region: { readonly rules: Region; phase: RegionPhase } | null;
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
    const opened = REGIONS.find((r) => r.opens.test(line)) ?? null;
    const current = open.get(key);
    if (current && continues(current, line, opened)) {
      add(current, record, line, opened);
      if (current.region?.rules.closesWith?.test(line)) {
        blocks.push(closed(current));
        open.delete(key);
      }
      continue;
    }
    if (current) blocks.push(closed(current));
    open.delete(key);
    const level = startLevel(record, line, opened, minLevel);
    if (!level) continue;
    const started: OpenBlock = { records: [], lines: [], level, tag: LEVEL_TAG.exec(line)?.[0] ?? null, region: null, frames: false };
    add(started, record, line, opened);
    open.set(key, started);
  }
  for (const block of open.values()) blocks.push(closed(block));
  return blocks.sort((a, b) => a.first.seq - b.first.seq);
}

/** The level of the block `line` starts, or `null` when it starts none. */
function startLevel(record: LogRecord, line: string, opened: Region | null, minLevel: LogErrorLevel): LogErrorLevel | null {
  if (record.level === "error" || opened || EXCEPTION.test(line) || CAUSE.test(line)) return "error";
  if (record.level === "warn" && minLevel === "warn") return "warn";
  return null;
}

function continues(block: OpenBlock, line: string, opened: Region | null): boolean {
  if (block.records.length >= MAX_BLOCK_RECORDS) return false;
  if (block.region) return !TIMESTAMP.test(line) && !(block.region.phase === "last-paragraph" && BLANK.test(line));
  if (opened) return true;
  const exception = EXCEPTION.test(line);
  // An exception under a warning is an error of its own, whatever level threshold the request has.
  if (block.level === "warn" && (exception || CAUSE.test(line))) return false;
  if (belongsToAnyBlock(line)) return true;
  // The exception under a logger line, until there are frames.
  if (exception) return !block.frames;
  return block.tag !== null && LEVEL_TAG.exec(line)?.[0] === block.tag;
}

function belongsToAnyBlock(line: string): boolean {
  return [STACK_FRAME, FRAMES_TAIL, CAUSE, SUPPRESSED, INDENTED, BLANK, BANNER, REQUIRE_STACK].some((pattern) => pattern.test(line));
}

function add(block: OpenBlock, record: LogRecord, line: string, opened: Region | null): void {
  block.records.push(record);
  block.lines.push(line);
  if (STACK_FRAME.test(line)) block.frames = true;
  if (!block.region) {
    if (opened) block.region = { rules: opened, phase: "body" };
  } else if (block.region.rules.lastSection?.test(line)) block.region.phase = "last-section";
  else if (block.region.phase === "last-section" && !BLANK.test(line)) block.region.phase = "last-paragraph";
}

/** The block without trailing blank lines (they belonged to it only in case it went on). */
function closed(block: OpenBlock): ErrorBlock {
  const [first] = block.records;
  if (!first) throw new Error("error block without records");
  let end = block.lines.length;
  while (end > 1 && BLANK.test(block.lines[end - 1] ?? "")) end -= 1;
  const lines = block.lines.slice(0, end);
  return { first, records: block.records.slice(0, end), lines, level: block.level, exception: exceptionOf(lines) };
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
