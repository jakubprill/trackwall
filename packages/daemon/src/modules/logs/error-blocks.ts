import type { LogErrorLevel, LogRecord } from "@trackwall/protocol";
import { BRACKETED_LEVEL, LEVEL_TAG, withoutTaskPrefix } from "./log-level.ts";

/**
 * Errors in the records of one source (§4.2, ADR-42): a record at the level threshold, an exception header, a
 * `Caused by:`, a failed Gradle test or the start of a report starts a block, and the lines that belong to it extend it: Java and Node stack frames, `Caused by:` and `Suppressed:`, an
 * exception header under a logger's `ERROR` line, indented lines (context of javac, tsc and Vite diagnostics), blank
 * lines, a line of asterisks, Node's `Require stack:` and further lines with the same level tag and no timestamp (Maven
 * `[ERROR]`, `npm error`). Whatever starts an error (an `error` record, an exception header, `Caused by:`, a report) under a warning starts an error of
 * its own, so an error does not depend on the requested level threshold. The Spring "APPLICATION FAILED TO START"
 * report and the Gradle `FAILURE:` report are regions that last until their end, because their paragraphs are not
 * indented, or until a line of the logger or build tool that follows them (`REPORT_END`) or another region's start. Only records of the same run and stream extend a block: stdout and stderr interleave arbitrarily.
 */

/** A Java (`\tat a.B.c(B.java:1)`) or Node (`    at fn (file.js:1:2)`) stack frame. */
export const STACK_FRAME = /^\s+at\s/;
/** The end of a Java stack trace that refers to the frames of the enclosing one (`... 12 more`). */
const FRAMES_TAIL = /^\s*\.\.\. \d+ (more|common frames omitted)\s*$/;
/** `Caused by:` in a Java stack trace, also indented under a `Suppressed:` exception. */
const CAUSE = /^\s*Caused by: /;
/** `Caused by:` and the cause's exception (group 1). */
const CAUSE_PARTS = /^\s*Caused by: (.+)$/;
/** A failed test in Gradle's test output (`OrdersTest > rejects FAILED`); its indented lines are the exception. */
const TEST_FAILED = /^\S.* > .+ FAILED\s*$/;
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
/**
 * A line that is no longer part of a report: the logger's next event (a date or a time at the start of the line), or
 * the build tool that ran the app (a Maven level tag, a Gradle `> Task`).
 */
const REPORT_END = [/^\[?(\d{4}-\d{2}-\d{2}[T ])?\d{2}:\d{2}:\d{2}/, BRACKETED_LEVEL, /^> Task /];
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
  readonly entries: readonly BlockEntry[];
  readonly level: LogErrorLevel;
  /** The last `Caused by:` of the main chain (not one under a `Suppressed:` exception) or the first exception header. */
  readonly exception: string | null;
}

/** A record of the block and its line without the mise task prefix, which the rules look at. */
interface BlockEntry {
  readonly record: LogRecord;
  readonly line: string;
}

interface OpenBlock {
  readonly entries: BlockEntry[];
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
    if (current && continues(current, record, line, opened)) {
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
    const started: OpenBlock = { entries: [], level, tag: LEVEL_TAG.exec(line)?.[0] ?? null, region: null, frames: false };
    add(started, record, line, opened);
    open.set(key, started);
  }
  for (const block of open.values()) blocks.push(closed(block));
  return blocks.sort((a, b) => a.first.seq - b.first.seq);
}

/** The level of the block `line` starts, or `null` when it starts none. */
function startLevel(record: LogRecord, line: string, opened: Region | null, minLevel: LogErrorLevel): LogErrorLevel | null {
  if (startsError(record, line, opened)) return "error";
  if (record.level === "warn" && minLevel === "warn") return "warn";
  return null;
}

/**
 * An indented line at `error` level is the context of a diagnostic (`b.old(Level.SEVERE);` under a javac warning), not
 * an error of its own; the level alone starts an error only at the start of a line.
 */
function startsError(record: LogRecord, line: string, opened: Region | null): boolean {
  if (opened !== null || EXCEPTION.test(line) || CAUSE.test(line) || TEST_FAILED.test(line)) return true;
  return record.level === "error" && !INDENTED.test(line);
}

function continues(block: OpenBlock, record: LogRecord, line: string, opened: Region | null): boolean {
  if (block.entries.length >= MAX_BLOCK_RECORDS) return false;
  if (block.region)
    return !opened && !REPORT_END.some((pattern) => pattern.test(line)) && !(block.region.phase === "last-paragraph" && BLANK.test(line));
  // What starts an error under a warning is an error of its own, whatever level threshold the request has.
  if (block.level === "warn" && startsError(record, line, opened)) return false;
  if (opened || belongsToAnyBlock(line)) return true;
  // The exception under a logger line, until there are frames.
  if (EXCEPTION.test(line)) return !block.frames;
  return block.tag !== null && LEVEL_TAG.exec(line)?.[0] === block.tag;
}

function belongsToAnyBlock(line: string): boolean {
  return [STACK_FRAME, FRAMES_TAIL, CAUSE, SUPPRESSED, INDENTED, BLANK, BANNER, REQUIRE_STACK].some((pattern) => pattern.test(line));
}

function add(block: OpenBlock, record: LogRecord, line: string, opened: Region | null): void {
  block.entries.push({ record, line });
  if (STACK_FRAME.test(line)) block.frames = true;
  if (!block.region) {
    if (opened) block.region = { rules: opened, phase: "body" };
  } else if (block.region.rules.lastSection?.test(line)) block.region.phase = "last-section";
  else if (block.region.phase === "last-section" && !BLANK.test(line)) block.region.phase = "last-paragraph";
}

/** The block without trailing blank lines (they belonged to it only in case it went on). */
function closed(block: OpenBlock): ErrorBlock {
  const [start] = block.entries;
  if (!start) throw new Error("error block without records");
  let end = block.entries.length;
  while (end > 1 && BLANK.test(block.entries[end - 1]?.line ?? "")) end -= 1;
  const entries = block.entries.slice(0, end);
  return { first: start.record, entries, level: block.level, exception: exceptionOf(entries.map((e) => e.line)) };
}

/**
 * The cause is the last `Caused by:` of the main chain. Java prints the causes of a `Suppressed:` exception at its
 * indentation or deeper, while the main chain is less indented (column 0 in Java, deeper in Gradle's test output).
 */
function exceptionOf(lines: readonly string[]): string | null {
  let cause: string | null = null;
  let suppressedIndent: number | null = null;
  for (const line of lines) {
    const indent = line.length - line.trimStart().length;
    if (SUPPRESSED.test(line)) suppressedIndent ??= indent;
    const match = CAUSE_PARTS.exec(line);
    if (!match || (suppressedIndent !== null && indent >= suppressedIndent)) continue;
    cause = match[1] ?? null;
    suppressedIndent = null;
  }
  if (cause !== null) return cause;
  for (const line of lines) {
    const match = EXCEPTION.exec(line);
    if (match?.[1]) return match[1];
  }
  return null;
}
