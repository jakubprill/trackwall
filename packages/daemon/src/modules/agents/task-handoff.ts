import { CommitHash, RepoId, TaskId } from "@trackwall/protocol";
import { z } from "zod";
import { TaskBranch } from "./task-branch.ts";

/**
 * A handoff (§4.4, ADR-143): the task whose session proposed a task, as the proposed task's sessions are told about it.
 * The facts come from the daemon's own task list and from git when the user approved the proposal, never from the
 * proposing agent's text, so the subtask can trust where to read the work it builds on: the task's id for
 * `get_task_changes`, its repo and branch, and the commit its branch was at.
 */
export const TaskHandoff = z.object({
  task: TaskId,
  repo: RepoId,
  branch: TaskBranch,
  /** The commit the handing task's branch was at when the user approved the proposal. */
  commit: CommitHash,
});
export type TaskHandoff = z.infer<typeof TaskHandoff>;

/** A handoff as a session start sees it: `ended` once the handing task is no longer on the list, so its changes cannot be read. */
export type HandoffFacts = (TaskHandoff & { ended: false }) | (Omit<TaskHandoff, "commit"> & { ended: true });
