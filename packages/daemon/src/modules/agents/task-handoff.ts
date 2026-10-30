import { CommitHash, HANDOFF_FILES_MAX, RepoId, type TaskHandoffState, TaskId } from "@trackwall/protocol";
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

/** What a handoff reads from git in the handing task's worktree. */
export interface HandoffGit {
  headCommit(dir: string): Promise<string | null>;
  countBetween(dir: string, from: string, to: string): Promise<number | undefined>;
  changedPathsBetween(dir: string, from: string, to: string, max: number): Promise<{ paths: string[]; truncated: boolean } | undefined>;
}

/**
 * Where the handing task's branch is now against the commit the subtask read last (`get_handoff`, ADR-144); `worktree`
 * is the handing task's, `undefined` once it ended.
 */
export async function handoffState(handoff: TaskHandoff, worktree: string | undefined, git: HandoffGit): Promise<TaskHandoffState> {
  const { task, repo, branch, commit: read } = handoff;
  const unchanged = { files: [], filesTruncated: false };
  if (worktree === undefined) return { task, repo, branch, read, ended: true, head: null, commits: null, ...unchanged };
  const head = await git.headCommit(worktree);
  if (head === null || head === read)
    return { task, repo, branch, read, ended: false, head, commits: head === null ? null : 0, ...unchanged };
  const [commits, changed] = await Promise.all([
    git.countBetween(worktree, read, head),
    git.changedPathsBetween(worktree, read, head, HANDOFF_FILES_MAX),
  ]);
  return {
    task,
    repo,
    branch,
    read,
    ended: false,
    head,
    commits: commits ?? null,
    files: changed?.paths ?? [],
    filesTruncated: changed?.truncated ?? false,
  };
}
