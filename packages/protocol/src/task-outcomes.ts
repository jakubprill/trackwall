import { z } from "zod";
import { TaskId } from "./agents.ts";
import { apiEndpoints } from "./api.ts";
import { FollowedMergeRequest } from "./merge-requests.ts";
import { VerificationState } from "./verification.ts";
import { RepoId } from "./workspace.ts";

/**
 * Task outcomes (ADR-154): what a task's work came to, for its row on the Sessions list, its grid tile and the
 * notification of a failed pipeline. The verdict of its last verification (§4.10) and the merge request from its
 * branch with its pipeline (§4.12), which the daemon follows in the background while the task lasts. Kept only in the
 * daemon's memory; the facade puts them together from `verification` and `merge-requests`.
 */

export const TaskOutcome = z.object({
  task: TaskId,
  repo: RepoId,
  /** The state of its last verification; `null` when it has had none. */
  verification: VerificationState.nullable(),
  /** The merge request from its branch as last read from the repo host; `null` before one was found. */
  mergeRequest: FollowedMergeRequest.nullable(),
});
export type TaskOutcome = z.infer<typeof TaskOutcome>;

const endpoint = apiEndpoints("task-outcomes");

export const taskOutcomesApi = {
  /** The outcome of every task that has a verification or a merge request; a read from the daemon's memory. */
  list: endpoint("list", z.object({}).strict(), z.array(TaskOutcome)),
};
