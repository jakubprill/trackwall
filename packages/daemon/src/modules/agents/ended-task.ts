import {
  type EndedTask,
  TASK_HISTORY_MAX_COMMITS,
  TASK_HISTORY_MAX_FILES,
  TASK_HISTORY_PROMPT_MAX_CHARS,
  TASK_HISTORY_SUMMARY_MAX_CHARS,
} from "@trackwall/protocol";
import { messageOf } from "../../infra/errors.ts";
import type { StoredTask } from "./task-file.ts";

/**
 * The record of a task the user is ending, for the task journal (ADR-150): read from the task list and from git in its
 * worktree before the worktree goes. The verdict is added by the facade, which knows the `verification` module.
 */

export type EndedTaskFacts = Omit<EndedTask, "verification">;

/** What the record reads from git in the task's worktree. */
export interface EndedTaskGit {
  headCommit(dir: string): Promise<string | null>;
  commitsBetween(
    dir: string,
    from: string,
    to: string,
    limit: number,
  ): Promise<{ total: number; commits: { hash: string; subject: string }[] } | undefined>;
  changedPathsBetween(dir: string, from: string, to: string, max: number): Promise<{ paths: string[]; truncated: boolean } | undefined>;
}

/**
 * The facts of `task` as it ends at `endedAt`. A git read that fails leaves its part empty and goes to `log`: the
 * record of what the task was is still worth keeping, and ending the task must not fail on it.
 */
export async function endedTaskFacts(
  task: StoredTask & { worktree: string },
  branchKept: boolean,
  endedAt: Date,
  git: EndedTaskGit,
  log: (msg: string) => void,
): Promise<EndedTaskFacts> {
  const facts: EndedTaskFacts = {
    task: task.id,
    repo: task.repo,
    title: task.title,
    prompt: task.prompt.slice(0, TASK_HISTORY_PROMPT_MAX_CHARS),
    branch: task.branch,
    baseBranch: task.baseBranch,
    base: task.base,
    head: null,
    branchKept,
    createdAt: task.createdAt,
    endedAt: endedAt.toISOString(),
    proposed: task.proposedBy !== null,
    item: task.item,
    handoffFrom: task.handoff?.task ?? null,
    summary: task.summary === null ? null : task.summary.text.slice(0, TASK_HISTORY_SUMMARY_MAX_CHARS),
    commits: [],
    commitsTotal: null,
    files: [],
    filesTruncated: false,
  };
  try {
    const head = await git.headCommit(task.worktree);
    if (head === null) return facts;
    const [range, changed] = await Promise.all([
      git.commitsBetween(task.worktree, task.base, head, TASK_HISTORY_MAX_COMMITS),
      git.changedPathsBetween(task.worktree, task.base, head, TASK_HISTORY_MAX_FILES),
    ]);
    return {
      ...facts,
      head,
      commits: range?.commits.map(({ hash, subject }) => ({ hash, subject })) ?? [],
      commitsTotal: range?.total ?? null,
      files: changed?.paths ?? [],
      filesTruncated: changed?.truncated ?? false,
    };
  } catch (err) {
    log(`reading the commits of ended task ${task.id} for the task journal: ${messageOf(err)}`);
    return facts;
  }
}
