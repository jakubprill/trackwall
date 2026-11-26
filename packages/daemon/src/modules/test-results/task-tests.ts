import {
  TASK_TESTS_MAX_CASES,
  TASK_TESTS_MAX_FAILURES,
  TASK_TESTS_MAX_PROBLEMS,
  type TaskTestCase,
  type TaskTestRef,
  type TaskTests,
  type TestFailure,
  type TestFix,
  type TestReportProblem,
  VERIFICATION_MAX_FAILURES,
} from "@trackwall/protocol";
import { DomainError } from "../../infra/errors.ts";
import { addCounts, emptyCounts, type ReportFailure } from "./junit-report.ts";
import { forAgent, type Mask, type ReadReport } from "./report-failure.ts";

/**
 * The tests of a task for its "Tests" tab (ADR-304): every case of the reports in its worktree, failed ones first, so a
 * cut list never drops a failure, and the failed ones with their message and trace as an agent gets them (§4.9). Every
 * name is masked like a log line, because a parameterized test can put a value it read into its name.
 */

/** The tests of reports read newest first; `changedAfter` is the caller's, from the task's files. */
export function taskTestsOf(read: readonly ReadReport[], mask: Mask): Omit<TaskTests, "changedAfter"> {
  const totals = emptyCounts();
  const failed: TaskTestCase[] = [];
  const skipped: TaskTestCase[] = [];
  const passed: TaskTestCase[] = [];
  const failures: TestFailure[] = [];
  const problems: TestReportProblem[] = [];
  let reports = 0;
  let newestMs = Number.NEGATIVE_INFINITY;
  for (const entry of read) {
    if ("problem" in entry) {
      problems.push({ path: entry.file.path, message: mask(entry.problem) });
      continue;
    }
    reports++;
    newestMs = Math.max(newestMs, entry.file.mtimeMs);
    addCounts(totals, entry.report.counts);
    listCases(entry, mask, { failed, skipped, passed }, failures);
  }
  const cases = [...failed, ...skipped, ...passed];
  return {
    totals,
    reports,
    newestReportAt: reports === 0 ? null : new Date(newestMs).toISOString(),
    cases: cases.slice(0, TASK_TESTS_MAX_CASES),
    failures,
    problems: problems.slice(0, TASK_TESTS_MAX_PROBLEMS),
    truncated: cases.length > TASK_TESTS_MAX_CASES || failed.length > failures.length || problems.length > TASK_TESTS_MAX_PROBLEMS,
  };
}

/** Sorts a report's cases by outcome, adding a failed one's details to `failures` while there is room. */
function listCases(
  { file, report }: Extract<ReadReport, { report: unknown }>,
  mask: Mask,
  lists: Record<"failed" | "skipped" | "passed", TaskTestCase[]>,
  failures: TestFailure[],
): void {
  const reportFailures = report.failures.values();
  for (const c of report.cases) {
    const listed = {
      report: file.path,
      suite: mask(c.suite),
      className: c.className === null ? null : mask(c.className),
      name: mask(c.name),
      kind: c.kind,
      timeSeconds: c.timeSeconds,
    };
    if (c.kind === "passed") lists.passed.push({ ...listed, failure: null });
    else if (c.kind === "skipped") lists.skipped.push({ ...listed, failure: null });
    else lists.failed.push({ ...listed, failure: detailed(reportFailures.next().value, file.path, failures, mask) });
  }
}

/** Adds a failed case's details to `failures` while there is room; its index there, or `null`. */
function detailed(failure: ReportFailure | undefined, report: string, failures: TestFailure[], mask: Mask): number | null {
  if (failure === undefined || failures.length >= TASK_TESTS_MAX_FAILURES) return null;
  failures.push(forAgent(failure, report, mask));
  return failures.length - 1;
}

/**
 * The test fix for failed tests of the "Tests" tab (ADR-304): the one the user picked, found again by its names in the
 * reports as they are now, or the first ones up to what a test fix carries (`test` `null`). Only the daemon's own reading
 * of the reports is the source: the request names a test, never its message or trace.
 */
export function tabTestFix(tests: TaskTests, test: TaskTestRef | null): TestFix {
  const picked =
    test === null
      ? tests.failures.slice(0, VERIFICATION_MAX_FAILURES)
      : tests.failures.filter((f) => f.report === test.report && f.className === test.className && f.name === test.name).slice(0, 1);
  if (picked.length === 0)
    throw new DomainError(
      "bad_request",
      test === null ? "the test reports have no failed test to fix" : `no failed test ${test.name} in ${test.report}`,
    );
  const failed = tests.totals.failures + tests.totals.errors;
  return { runId: null, outdated: tests.changedAfter, failures: picked, otherFailures: Math.max(0, failed - picked.length) };
}
