import { z } from "zod";
import { TaskId } from "./agents.ts";
import type { Endpoint } from "./api.ts";
import { LogError } from "./logs.ts";
import { MiseTaskName } from "./mise.ts";
import { TestCounts, TestFailure } from "./test-results.ts";
import { RepoId } from "./workspace.ts";

/**
 * Contract of the `verification` module (§4.10, ADR-64): the verification of a task, that is its mise task `test` run
 * in the task's worktree and summed up in one verdict from the exit code, the JUnit reports the run wrote (ADR-60) and
 * the errors in its log (ADR-42). One button in the task panel and one MCP tool, so the user and the agent read the
 * same result. Kept only in the daemon's memory, the last one of every task. Each action is
 * `POST /api/verification/<action>`.
 */

/** The mise task a verification runs; the same kind of convention as `setup` and `build` in the batch command (ADR-27). */
export const VERIFY_MISE_TASK = "test";
/** Most failed tests a verification keeps; the rest is in `get_test_results`. */
export const VERIFICATION_MAX_FAILURES = 5;
/** Most errors from the log a verification keeps; the rest is in `get_errors`. */
export const VERIFICATION_MAX_ERRORS = 5;

/**
 * `running` until the run's process group has ended; `passed` when the mise task exited with 0 and no test the run
 * reported failed, and every report it wrote could be read; `failed` otherwise; `cancelled` when the user stopped the run (or the daemon exited).
 */
export const VerificationState = z.enum(["running", "passed", "failed", "cancelled"]);
export type VerificationState = z.infer<typeof VerificationState>;

/** The test reports the run wrote: only reports written since the run started count. */
export const VerificationTests = z.object({
  totals: TestCounts,
  /** Reports written by the run. */
  reports: z.number().int().nonnegative(),
  /** Reports the run wrote that could not be read (too large, not JUnit XML); any makes the verification fail. */
  unreadReports: z.number().int().nonnegative(),
  /** Reports left by earlier runs; some without `reports` means the run wrote none (e.g. Gradle found the tests up to date). */
  earlierReports: z.number().int().nonnegative(),
  /** The search for reports stopped at a limit, so `totals` may miss some. */
  truncated: z.boolean(),
});
export type VerificationTests = z.infer<typeof VerificationTests>;

export const Verification = z.object({
  task: TaskId,
  repo: RepoId,
  miseTask: MiseTaskName,
  state: VerificationState,
  /** The run of the mise task: a verification started while the task's `test` already ran waits for that run. */
  runId: z.string(),
  /** ISO 8601, when the run started. */
  startedAt: z.string(),
  /** ISO 8601; `null` while running, and on one cancelled because the daemon stopped during its run. */
  finishedAt: z.string().nullable(),
  /** The leader's exit code; `null` while running or when a signal ended it. */
  exitCode: z.number().int().nullable(),
  /** Why it failed, or a note on a pass (no test reports); `null` otherwise. */
  message: z.string().nullable(),
  /** `null` while running, after a cancel, or when the reports could not be read (`message` says why). */
  tests: VerificationTests.nullable(),
  /** The first failed tests, at most `VERIFICATION_MAX_FAILURES`; masked like `get_test_results`. */
  failures: z.array(TestFailure),
  /** The first errors in this run's log when it failed, at most `VERIFICATION_MAX_ERRORS`; empty on a pass. */
  errors: z.array(LogError),
  /** The end of the run's output when it failed (masked); empty otherwise. */
  lastLines: z.array(z.string()),
});
export type Verification = z.infer<typeof Verification>;

const TaskRequest = z.object({ task: TaskId }).strict();

function endpoint<Req extends z.ZodType, Data extends z.ZodType>(action: string, request: Req, data: Data): Endpoint<Req, Data> {
  return { path: `/api/verification/${action}`, request, data };
}

export const verificationApi = {
  /**
   * Starts the task's verification in the background and returns it at once (`running`); while one runs, that one.
   * `not_found` when the worktree has no mise task `test`, `mise_unavailable` when its mise config is not trusted.
   */
  start: endpoint("start", TaskRequest, Verification),
  /** The task's last verification, also from before a daemon restart; `null` when there was none. */
  get: endpoint("get", TaskRequest, Verification.nullable()),
  /** Stops the running verification's mise task like a stop in the task panel; the verification ends `cancelled`. */
  cancel: endpoint("cancel", TaskRequest, Verification.nullable()),
};
