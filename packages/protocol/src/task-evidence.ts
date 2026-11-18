import { z } from "zod";
import { ReproTest, TaskId } from "./agents.ts";
import { apiEndpoints } from "./api.ts";
import { FreshAutoReview } from "./auto-review.ts";
import { CopilotUsage, ModelCalls } from "./copilot-usage.ts";
import { ReproductionCheck } from "./reproduction.ts";
import { Verification } from "./verification.ts";

/**
 * Task evidence (ADR-276): what Trackwall knows about a task's change beyond the agent's own summary, in one answer, so
 * that the evidence card above the task's diff, the draft of its merge request (ADR-238) and later readers word the same
 * facts. Each fact says whose word it is: the user's (the plan they approved), the agent's (the test it names) or
 * Trackwall's own (the reproduction check, the verification, the rules check, what Copilot CLI ran on), and a check of
 * Trackwall's says when the task's changes moved on after it. Read now from the daemon's memory and the task's
 * worktree; the facade puts it together from `agents`, `verification` and `reproduction`.
 */

/** The agent's reproduction test (ADR-222) and Trackwall's last check of that same test (ADR-227). */
export const ReproductionEvidence = z.object({
  /** What the agent reported: its word, not checked by itself. */
  test: ReproTest,
  /** The last check of this test, also while it runs; `null` when it was never checked, or only an earlier test the agent named. */
  check: ReproductionCheck.nullable(),
  /** The task's files changed after the check started, so its verdict is about an earlier version of the changes. */
  outdated: z.boolean(),
});
export type ReproductionEvidence = z.infer<typeof ReproductionEvidence>;

export const TaskEvidence = z.object({
  task: TaskId,
  /** The user approved the agent's plan before it changed files (ADR-229). */
  planApproved: z.boolean(),
  /** `null` while the agent has named no reproduction test. */
  reproduction: ReproductionEvidence.nullable(),
  /** The task's last verification (ADR-64), with `outdated` (ADR-209); `null` when it has had none. */
  verification: Verification.nullable(),
  /** The task's last finished rules check (ADR-234) and whether the changes moved on after it; `null` without one. */
  rules: FreshAutoReview.nullable(),
  /** What the task's conversation used (ADR-228); `null` when its log is unknown. */
  usage: CopilotUsage.nullable(),
  /** The conversation's own model calls per model, the most first; empty when it made none or its log is unknown. */
  models: z.array(ModelCalls),
});
export type TaskEvidence = z.infer<typeof TaskEvidence>;

const endpoint = apiEndpoints("task-evidence");

export const taskEvidenceApi = {
  /** The task's evidence, read now; `not_found` for a task the daemon does not know. */
  get: endpoint("get", z.object({ task: TaskId }).strict(), TaskEvidence),
};
