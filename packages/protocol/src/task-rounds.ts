import { z } from "zod";
import { TaskId } from "./agents.ts";
import { apiEndpoints } from "./api.ts";
import { WorkingTreeChanges } from "./changes.ts";
import { CommitHash } from "./workspace.ts";

/**
 * Task rounds (§4.4, ADR-168): a round is one turn of a task's agent that changed the worktree. When the turn ends, the
 * daemon commits what the agent left uncommitted on the task branch (a round commit), so each round has a commit of its
 * own, its own diff, and can be undone; the round commits are squashed before the branch is pushed. Everything stays
 * local: nothing is pushed without the user.
 */

/** Rounds kept per task, newest first; an older one drops out of the list (its commits stay on the branch). */
export const TASK_ROUNDS_KEPT = 200;

export const TaskRound = z.object({
  /** 1 for a task's first round, one more for each next one; an undone round's number is not given again. */
  number: z.number().int().positive(),
  /** Where the worktree was when the round started: the previous round's `to`, or the commit HEAD was at when the turn started. */
  from: CommitHash,
  /** HEAD after the round, with its round commit when there is one. */
  to: CommitHash,
  /** ISO 8601. */
  endedAt: z.string(),
  /** The commit the daemon made of what the agent left uncommitted; `null` when the agent committed everything itself. */
  roundCommit: CommitHash.nullable(),
  /**
   * The worktree had changes from outside the agent's rounds when this round started (a hand edit, a commit, or a turn the
   * daemon did not see start): undoing the round would drop them too, so it is not undone.
   */
  outside: z.boolean(),
  /** ISO 8601 of the undo; `null` while the round stands. */
  undoneAt: z.string().nullable(),
});
export type TaskRound = z.infer<typeof TaskRound>;

/**
 * A task's rounds, newest first, with what "Undo round" would do now: `undo` names the round it undoes (the newest one that
 * stands), and `blocked` says why that one cannot be undone now; both `null` without a round that stands.
 */
export const TaskRounds = z.object({
  rounds: z.array(TaskRound).max(TASK_ROUNDS_KEPT),
  undo: z.number().int().positive().nullable(),
  blocked: z.string().nullable(),
  /** Why the last round's end could not be committed (no git identity, HEAD off the task branch, a merge in progress); `null` when it was. */
  problem: z.string().nullable(),
});
export type TaskRounds = z.infer<typeof TaskRounds>;

const RoundRequest = z.object({ task: TaskId, round: TaskRound.shape.number }).strict();

const endpoint = apiEndpoints("agents");

export const taskRoundsApi = {
  /** The task's rounds and whether its newest round can be undone now. */
  rounds: endpoint("task-rounds", z.object({ task: TaskId }).strict(), TaskRounds),
  /** Files and diff of one round, from its `from` to its `to` commit; `not_found` for a round no longer kept. */
  roundChanges: endpoint("task-round-changes", RoundRequest, WorkingTreeChanges),
  /**
   * Undoes round `round`, which must be the one `rounds` names in `undo` (`bad_request` otherwise, also with the reason
   * it cannot be undone now): the worktree and the task branch go back to the round's `from`, and the task's agent is told.
   * Only from the UI, never from MCP.
   */
  undoRound: endpoint("undo-task-round", RoundRequest, TaskRounds),
};
