import { z } from "zod";

/**
 * Test results (ADR-60): the outcome of the latest test runs in a repo root or a task's worktree, read from the JUnit
 * XML reports the build tools leave on disk (Maven Surefire and Failsafe, Gradle, Ant, `junit.xml` of jest-junit and
 * Vitest). The contract of the `get_test_results` MCP tool: an agent learns which tests failed and why without
 * reading the build log. Trackwall runs no tests for this; the reports are whatever the last run wrote.
 */

/** Most failed tests in one result: more would not fit usefully in an agent's context. */
export const TEST_RESULTS_MAX_FAILURES = 50;
/** Most reports listed in one result, newest first; the totals count every report read. */
export const TEST_RESULTS_MAX_REPORTS = 100;
/** Most unreadable reports listed in one result. */
export const TEST_RESULTS_MAX_PROBLEMS = 20;
/** Most lines of one failure's stack trace kept from its start; the `Caused by` lines further down are kept too. */
export const TEST_FAILURE_HEAD_LINES = 12;
/** Most characters of one failure's message. */
export const TEST_FAILURE_MESSAGE_MAX_CHARS = 2000;
/**
 * Most characters of one stack trace line: its first line repeats the message, and an assertion on a large JSON or
 * object writes hundreds of KB into it.
 */
export const TEST_FAILURE_LINE_MAX_CHARS = 500;

/** Test cases by outcome; `tests` counts all of them, a passed one is in none of the other counts. */
export const TestCounts = z.object({
  tests: z.number().int().nonnegative(),
  /** An assertion did not hold (`<failure>`). */
  failures: z.number().int().nonnegative(),
  /** The test threw something other than an assertion error (`<error>`). */
  errors: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  /** Sum of the test case times; `null` when no case had a time. */
  timeSeconds: z.number().nonnegative().nullable(),
});
export type TestCounts = z.infer<typeof TestCounts>;

/** One report file. */
export const TestReport = TestCounts.extend({
  /** Relative to the searched directory, with `/`, e.g. `orders/target/surefire-reports/TEST-a.OrderTest.xml`. */
  path: z.string(),
  /** When the file was last written: a report older than the run you started is from an earlier run. */
  modifiedAt: z.iso.datetime(),
});
export type TestReport = z.infer<typeof TestReport>;

/** A failed test case (`failure` or `error`). */
export const TestFailure = z.object({
  /** The report it comes from (`TestReport.path`). */
  report: z.string(),
  /** The test suite's name (usually the test class). */
  suite: z.string(),
  /** The test case's `classname`; `null` when the report has none. */
  className: z.string().nullable(),
  name: z.string(),
  kind: z.enum(["failure", "error"]),
  /** The exception type, e.g. `org.opentest4j.AssertionFailedError`; `null` when the report has none. */
  type: z.string().nullable(),
  /** The failure message, with secrets masked; `null` when the report has none. */
  message: z.string().nullable(),
  /** The stack trace lines kept: its start and every `Caused by` with the frame after it, each cut, secrets masked. */
  lines: z.array(z.string()),
  /** How many stack trace lines `lines` leaves out. */
  omittedLines: z.number().int().nonnegative(),
  timeSeconds: z.number().nonnegative().nullable(),
});
export type TestFailure = z.infer<typeof TestFailure>;

/** A report that could not be read or is not a JUnit report. */
export const TestReportProblem = z.object({ path: z.string(), message: z.string() });
export type TestReportProblem = z.infer<typeof TestReportProblem>;

export const TestResults = z.object({
  /** The directory searched: the repo root or the task's worktree. */
  dir: z.string(),
  /** Every report read (also those not listed in `reports`). */
  totals: TestCounts,
  /** Newest first, at most `TEST_RESULTS_MAX_REPORTS`. */
  reports: z.array(TestReport),
  /** In report order, newest first, at most `TEST_RESULTS_MAX_FAILURES`. */
  failures: z.array(TestFailure),
  problems: z.array(TestReportProblem),
  /**
   * Reports found but left out by `since`: written before it. Some but no `reports` means the run wrote none, e.g. a
   * Gradle `test` task that was up to date and kept its old reports.
   */
  earlierReports: z.number().int().nonnegative(),
  /** A list above was cut, or the search stopped at its limit of directories or reports, so totals may miss reports. */
  truncated: z.boolean(),
});
export type TestResults = z.infer<typeof TestResults>;
