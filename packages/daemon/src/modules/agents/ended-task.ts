import {
  type EndedTask,
  TASK_HISTORY_MAX_COMMITS,
  TASK_HISTORY_MAX_FILES,
  TASK_HISTORY_PROMPT_MAX_CHARS,
  TASK_HISTORY_SUMMARY_MAX_CHARS,
} from "@trackwall/protocol";
import { messageOf } from "../../infra/errors.ts";
import type { ConversationUse } from "./copilot-usage-log.ts";
import type { StoredTask } from "./task-file.ts";

/**
 * The record of a task the user is ending, for the task journal (ADR-150): read from the task list and from git before
 * its branch can go. Git is read in the repo root on the branch ref, not in the worktree, so a worktree removed by hand
 * or by an earlier end that then failed still gives the branch's commits. What the task's conversation used, and on
 * which models, comes from Copilot CLI's event log (ADR-228). The verdict is added by the facade, which knows the
 * `verification` module.
 */

export type EndedTaskFacts = Omit<EndedTask, "verification">;

/** What the record reads from git in the task's repo. */
export interface EndedTaskGit {
  commitsBetween(
    dir: string,
    from: string,
    to: string,
    limit: number,
  ): Promise<{ total: number; commits: { hash: string; subject: string }[] } | undefined>;
  changedPathsBetween(dir: string, from: string, to: string, max: number): Promise<{ paths: string[]; truncated: boolean } | undefined>;
}

/** How the task ends, besides what git says. */
export interface TaskEnding {
  /** The task's round commits (ADR-168): their subject says only "WIP round", so the record lists the other commits. */
  roundCommits: ReadonlySet<string>;
  branchKept: boolean;
  endedAt: Date;
  /** What the task's conversation used over its life, read from its event log once its sessions stopped (ADR-228). */
  conversation: ConversationUse;
}

/**
 * The facts of `task` as it ends. A git read that fails (the branch is gone) leaves its part empty and goes to `log`: the
 * record of what the task was is still worth keeping, and ending the task must not fail on it.
 */
export async function endedTaskFacts(
  task: StoredTask,
  { roundCommits, branchKept, endedAt, conversation }: TaskEnding,
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
    model: task.model,
    usage: conversation.usage,
    models: conversation.models,
  };
  // The full ref, so a tag or a path of the same name cannot stand for the branch.
  const branch = `refs/heads/${task.branch}`;
  try {
    const [range, changed] = await Promise.all([
      git.commitsBetween(task.repoDir, task.base, branch, TASK_HISTORY_MAX_COMMITS),
      git.changedPathsBetween(task.repoDir, task.base, branch, TASK_HISTORY_MAX_FILES),
    ]);
    if (range === undefined) return facts;
    return {
      ...facts,
      head: range.commits[0]?.hash ?? task.base,
      commits: range.commits.filter(({ hash }) => !roundCommits.has(hash)).map(({ hash, subject }) => ({ hash, subject })),
      commitsTotal: range.total,
      files: changed?.paths ?? [],
      filesTruncated: changed?.truncated ?? false,
    };
  } catch (err) {
    log(`reading the commits of ended task ${task.id} for the task journal: ${messageOf(err)}`);
    return facts;
  }
}
