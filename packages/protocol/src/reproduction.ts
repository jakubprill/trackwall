import { z } from "zod";
import { ReproTest, TaskId } from "./agents.ts";
import { apiEndpoints } from "./api.ts";
import { RepoId } from "./workspace.ts";

/**
 * The reproduction check of a task (ADR-227, §4.27): Trackwall's own answer to "does the agent's reproduction test
 * (ADR-222) fail without the fix and pass with it?". The daemon runs the repo's mise task `test`, filtered to the test's
 * class when the mise task takes a filter, twice in a copy of the repo it makes for the check: first on the task's base
 * commit with only the task's test files, then with all of the task's changes. The task's own worktree is never touched.
 */

/** What one run said about the reproduction test: its test cases found in the reports the run wrote. */
export const ReproductionOutcome = z.enum(["failed", "passed", "skipped", "missing"]);
export type ReproductionOutcome = z.infer<typeof ReproductionOutcome>;

/** Most characters of a failure's type and message kept from a report. */
export const REPRODUCTION_FAILURE_MAX_CHARS = 300;

/** One run of the check, on the base or with the change. */
export const ReproductionRun = z.object({
  runId: z.string(),
  exitCode: z.number().int().nullable(),
  /**
   * `failed` when one of the test's cases failed, `passed` when all ran and passed, `skipped` when all were skipped, and
   * `missing` when the run's reports have none of them (the test did not compile, or nothing ran it).
   */
  outcome: ReproductionOutcome,
  /** How many test cases of the reports are the test's (more than one for a parameterized test). */
  cases: z.number().int().nonnegative(),
  /** The first failed case's exception type and message as its report has them, secrets masked and cut; `null` without one. */
  failure: z.object({ type: z.string().nullable(), message: z.string().nullable() }).nullable(),
});
export type ReproductionRun = z.infer<typeof ReproductionRun>;

/**
 * `reproduced`: it failed on the base and passed with the change. `not_reproduced`: it passed on the base, or it did not
 * pass with the change. `inconclusive`: the check could not tell (no Java test, the test not among the task's changes,
 * the copy or a run refused, the test not in a run's reports). `cancelled`: stopped by the user, the task's end or the
 * daemon's stop.
 */
export const ReproductionState = z.enum(["running", "reproduced", "not_reproduced", "inconclusive", "cancelled"]);
export type ReproductionState = z.infer<typeof ReproductionState>;

/** What a running check is doing: making its copy, running on the base, running with the change. */
export const ReproductionPhase = z.enum(["copy", "base", "change"]);
export type ReproductionPhase = z.infer<typeof ReproductionPhase>;

export const ReproductionCheck = z.object({
  task: TaskId,
  repo: RepoId,
  /** The agent's reproduction test this check is about, as it was when the check started. */
  test: ReproTest,
  /** The test class the runs were filtered to; `null` when the repo's mise task `test` takes no filter, so all tests ran. */
  filter: z.string().nullable(),
  state: ReproductionState,
  /** `null` once the check has ended. */
  phase: ReproductionPhase.nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  base: ReproductionRun.nullable(),
  change: ReproductionRun.nullable(),
  /** Why the check ended as it did, in one sentence; `null` for a plain `reproduced`. */
  message: z.string().nullable(),
});
export type ReproductionCheck = z.infer<typeof ReproductionCheck>;

const TaskRequest = z.object({ task: TaskId }).strict();

const endpoint = apiEndpoints("reproduction");

/** The task's reproduction check: started from the task panel, read while it runs, stopped. */
export const reproductionApi = {
  start: endpoint("start", TaskRequest, ReproductionCheck),
  get: endpoint("get", TaskRequest, ReproductionCheck.nullable()),
  cancel: endpoint("cancel", TaskRequest, ReproductionCheck.nullable()),
};
