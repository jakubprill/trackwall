import { z } from "zod";
import { TaskId } from "./agents.ts";
import { apiEndpoints } from "./api.ts";
import { CommitHash } from "./workspace.ts";

/**
 * A task's refresh from its base branch (§4.4, ADR-244): the newest commits of the branch the task started from are merged
 * into the task branch, so the agent works on today's code. A merge, never a rebase: the branch keeps its history, so a
 * pushed branch needs no force push. Nothing changes when the merge would conflict; the files are named instead.
 */

/** The branch the refresh merged from, as git names it: `origin/main`, or `main` without a remote that has it. */
const FromBranch = z.string();

export const TaskRefresh = z.discriminatedUnion("state", [
  /** The task branch already has every commit of `from`. */
  z.object({ state: z.literal("up-to-date"), from: FromBranch }),
  /**
   * Merging `from` would conflict in `files`: nothing was changed. `commits` is how many commits of `from` the task
   * branch does not have.
   */
  z.object({ state: z.literal("conflicts"), from: FromBranch, commits: z.number().int().positive(), files: z.array(z.string()) }),
  /** `commits` commits of `from` were merged; `base` is the task's new base commit, the tip of `from`. */
  z.object({ state: z.literal("refreshed"), from: FromBranch, commits: z.number().int().positive(), base: CommitHash }),
]);
export type TaskRefresh = z.infer<typeof TaskRefresh>;

const endpoint = apiEndpoints("agents");

export const taskRefreshApi = {
  /**
   * Merges the newest commits of the task's base branch into the task branch, after a fetch of the main remote. Refused
   * (`bad_request`) while the agent is in a turn, while the worktree has changes outside a commit or an operation in
   * progress, and for a task without a base branch. Only from the UI, never from MCP.
   */
  refreshTask: endpoint("refresh-task", z.object({ task: TaskId }).strict(), TaskRefresh),
};
