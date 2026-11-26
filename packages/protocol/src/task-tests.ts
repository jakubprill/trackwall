import { z } from "zod";
import { PromptDelivery, TaskId } from "./agents.ts";
import { apiEndpoints } from "./api.ts";
import { TestCounts, TestFailure, TestReportProblem } from "./test-results.ts";

/**
 * The tests of a task (ADR-304): every test case of the JUnit reports in the task's worktree, from Verify and from the
 * agent's own runs alike, for the "Tests" tab of the task panel, which shows the failed ones first and the rest on
 * request, without pages. The reports are read on every request, as `get_test_results` reads them (ADR-60).
 */

/** Most test cases one answer lists: a large multi-module repo has a few thousand; the counts cover every case. */
export const TASK_TESTS_MAX_CASES = 10_000;
/** Most failed tests one answer details; past it a failed case is listed without its message and trace. */
export const TASK_TESTS_MAX_FAILURES = 200;
/** Most unreadable reports one answer lists. */
export const TASK_TESTS_MAX_PROBLEMS = 20;

/** One test case of a report, with its outcome. */
export const TaskTestCase = z.object({
  /** The report it comes from, relative to the worktree with `/`. */
  report: z.string(),
  suite: z.string(),
  /** The test case's `classname`; `null` when the report has none. */
  className: z.string().nullable(),
  name: z.string(),
  kind: z.enum(["passed", "skipped", "failure", "error"]),
  timeSeconds: z.number().nonnegative().nullable(),
  /** For a failed case, its index in `TaskTests.failures`; `null` for any other case or one past `TASK_TESTS_MAX_FAILURES`. */
  failure: z.number().int().nonnegative().nullable(),
});
export type TaskTestCase = z.infer<typeof TaskTestCase>;

export const TaskTests = z.object({
  /** Every case of every report read, also those past `TASK_TESTS_MAX_CASES`. */
  totals: TestCounts,
  /** Reports read. */
  reports: z.number().int().nonnegative(),
  /** ISO 8601, when the newest report was written; `null` without a report. */
  newestReportAt: z.iso.datetime().nullable(),
  /** Failed cases first, then skipped, then passed, each in report order (newest report first). */
  cases: z.array(TaskTestCase),
  /** The failed cases with their message and the start of their trace, masked like `get_test_results`. */
  failures: z.array(TestFailure),
  problems: z.array(TestReportProblem),
  /** A file the task changed was written after the newest report, so some results may be about earlier changes. */
  changedAfter: z.boolean(),
  /** A list above was cut, or the search for reports stopped at its limit. */
  truncated: z.boolean(),
});
export type TaskTests = z.infer<typeof TaskTests>;

/** A failed test by its names, as the Tests tab lists it; the daemon finds it again in the reports. */
export const TaskTestRef = z
  .object({
    report: z.string().min(1).max(1000),
    className: z.string().max(1000).nullable(),
    name: z.string().max(1000),
  })
  .strict();
export type TaskTestRef = z.infer<typeof TaskTestRef>;

const TaskRequest = z.object({ task: TaskId }).strict();

const endpoint = apiEndpoints("task-tests");

export const taskTestsApi = {
  /** The tests of the reports in the task's worktree; `not_found` for an unknown or ended task. */
  get: endpoint("get", TaskRequest, TaskTests),
  /**
   * Asks the task's agent to fix one failed test of the reports in its worktree, or the first of them (`test` `null`),
   * as a test fix for `get_review_comments` (ADR-302). `bad_request` when the reports have no such failed test.
   */
  fixTests: endpoint("fix-tests", TaskRequest.extend({ test: TaskTestRef.nullable() }), z.object({ delivery: PromptDelivery })),
};
