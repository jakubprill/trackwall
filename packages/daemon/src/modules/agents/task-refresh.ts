import type { TaskRefresh } from "@trackwall/protocol";
import { DomainError, messageOf } from "../../infra/errors.ts";

/**
 * A task's refresh from its base branch (§4.4, ADR-245): the newest commit of the branch the task started from, after a
 * fetch, is merged into the task branch, and becomes the task's base, so the task's changes stay its own work. The merge
 * is tried in memory first: a merge that would conflict changes nothing and names the files, so the worktree is never
 * left half merged for the user or the agent to sort out. The caller runs it in the task's queue of round steps, outside a
 * turn (`TaskRoundList.refreshWithRoundsSquashed`), and keeps the new base in the task list.
 */

// The types below repeat the shape of the types from `vcs` (`RoundPlace`, `RoundWorktree`, `BranchTip`), because a
// module does not import a neighbouring module (§4); the compiler checks they match where the facade passes `Vcs`.

/** The task to refresh: its worktree, repo root, branch and the branch it started from (`null` from a detached HEAD). */
export interface RefreshPlace {
  worktree: string;
  repoDir: string;
  branch: string;
  baseBranch: string | null;
}

/** What a refresh needs from `vcs` (`base-refresh.ts`, `trial-merge.ts`); wired in the facade. */
export interface RefreshVcs {
  roundWorktree(place: RefreshPlace): Promise<{ head: string | null; onBranch: boolean; uncommitted: number; blocker: string | null }>;
  freshBaseTip(repoDir: string, branch: string): Promise<{ name: string; commit: string } | null>;
  isAncestor(dir: string, ancestor: string, commit: string): Promise<boolean>;
  countBetween(dir: string, from: string, to: string): Promise<number | undefined>;
  mergeTree(repoDir: string, ours: string, theirs: string): Promise<{ tree: string; conflicts: string[] }>;
  commitMerge(place: RefreshPlace, head: string, tree: string, theirs: string, message: string): Promise<string>;
}

/** A refresh's result, with the merge commit and the new base when it merged. */
export interface RefreshDone {
  result: TaskRefresh;
  /** HEAD after the merge; `null` when nothing was merged. */
  head: string | null;
}

/**
 * Refreshes `task` from its base branch. `squash` squashes the task's round commits on HEAD and returns the new HEAD
 * (ADR-168); it runs only once the merge is known to be clean, so a refresh that merges nothing rewrites nothing.
 */
export async function refreshTask(task: RefreshPlace, vcs: RefreshVcs, squash: (head: string) => Promise<string>): Promise<RefreshDone> {
  const { baseBranch } = task;
  if (baseBranch === null)
    throw new DomainError("bad_request", `task ${task.branch} started from a detached HEAD, so it has no base branch to refresh from`);
  const head = await cleanHead(task, vcs);
  const tip = await vcs.freshBaseTip(task.repoDir, baseBranch).catch((err: unknown) => {
    throw new DomainError("repo_unavailable", `${baseBranch} could not be fetched: ${messageOf(err)}`);
  });
  if (tip === null)
    throw new DomainError("bad_request", `the repo no longer has the branch ${baseBranch}, which task ${task.branch} started from`);
  if (await vcs.isAncestor(task.worktree, tip.commit, head)) return { result: { state: "up-to-date", from: tip.name }, head: null };
  const commits = await vcs.countBetween(task.worktree, head, tip.commit);
  if (commits === undefined) throw new Error(`git does not know commit ${head}`);
  const merged = await vcs.mergeTree(task.repoDir, head, tip.commit);
  if (merged.conflicts.length > 0) return { result: { state: "conflicts", from: tip.name, commits, files: merged.conflicts }, head: null };
  // The squashed history holds the same files as `head`, so the tree merged from `head` is the squashed one's merge too.
  const ours = await squash(head);
  const merge = await vcs.commitMerge(task, ours, merged.tree, tip.commit, `Merge ${tip.name} into ${task.branch}`);
  return { result: { state: "refreshed", from: tip.name, commits, base: tip.commit }, head: merge };
}

/** HEAD of the task branch, when the worktree holds nothing a merge could mix with or lose. */
async function cleanHead(task: RefreshPlace, vcs: RefreshVcs): Promise<string> {
  const now = await vcs.roundWorktree(task);
  if (now.blocker !== null) throw new DomainError("bad_request", `the task cannot be refreshed now: ${now.blocker}`);
  if (!now.onBranch || now.head === null)
    throw new DomainError("bad_request", `the task cannot be refreshed now: HEAD is not on the task branch ${task.branch}`);
  if (now.uncommitted > 0)
    throw new DomainError(
      "bad_request",
      "the worktree has changes outside a commit (made by hand, or a turn that was not saved as a round): commit or discard them before refreshing",
    );
  return now.head;
}
