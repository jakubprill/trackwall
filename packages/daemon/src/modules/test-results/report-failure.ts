import {
  TEST_FAILURE_HEAD_LINES,
  TEST_FAILURE_LINE_MAX_CHARS,
  TEST_FAILURE_MESSAGE_MAX_CHARS,
  type TestFailure,
} from "@trackwall/protocol";
import type { JunitReport, ReportFailure } from "./junit-report.ts";
import type { ReportFile } from "./report-files.ts";

/**
 * A report as read (ADR-60) and a failed test of it for an agent or the user (§4.9): every text masked like a log line
 * first, then cut to the limits of `protocol`, so a cut never leaves half a secret unmasked.
 */

/** A report file with its parsed content, or why it could not be read. */
export type ReadReport = { file: ReportFile; report: JunitReport } | { file: ReportFile; problem: string };
/** Masks secret values like a log line. */
export type Mask = (text: string) => string;

/** The line that starts a cause in a Java stack trace. */
const CAUSED_BY = /^\s*Caused by:/;

/** A failed test for an agent: every text masked first, then cut, so a cut never leaves half a secret unmasked. */
export function forAgent({ stack, ...failure }: ReportFailure, report: string, mask: Mask): TestFailure {
  const masked = (text: string | null) => (text === null ? null : mask(text));
  return {
    ...failure,
    report,
    suite: mask(failure.suite),
    className: masked(failure.className),
    name: mask(failure.name),
    type: masked(failure.type),
    message: masked(failure.message)?.slice(0, TEST_FAILURE_MESSAGE_MAX_CHARS) ?? null,
    ...trimStack(mask(stack)),
  };
}

/**
 * The start of a stack trace and every `Caused by` with the frame after it, each line cut: the thrown exception and
 * its root cause are what an agent needs, the frames of the test framework in between are not.
 */
export function trimStack(text: string): { lines: string[]; omittedLines: number } {
  const all = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  const kept = all.filter((line, i) => i < TEST_FAILURE_HEAD_LINES || CAUSED_BY.test(line) || CAUSED_BY.test(all[i - 1] ?? ""));
  return { lines: kept.map((line) => line.slice(0, TEST_FAILURE_LINE_MAX_CHARS)), omittedLines: all.length - kept.length };
}
