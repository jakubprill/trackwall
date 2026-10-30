import { z } from "zod";

/**
 * Sync of all repos in the projects folder (§4.5, §7 "Sync", ADR-21): fetch and fast-forward of the default branch,
 * in the background, with a result per repo. Kept only in the daemon's memory, like clones.
 */

/**
 * Why the default branch was not moved, although the fetch may have succeeded. Every reason leaves the repo untouched:
 * sync never merges, rebases or overwrites local changes.
 */
export const SyncSkipReason = z.enum([
  /** The repo has neither `origin` nor a single other remote. */
  "no-remote",
  /** The remote does not say which branch is the default (no `refs/remotes/<remote>/HEAD`, also after `remote set-head --auto`). */
  "no-default-branch",
  /** The default branch does not exist locally; the fetch got the changes, but there is nothing to move. */
  "no-local-branch",
  /** The default branch is checked out, and the working directory has changes in tracked files. */
  "dirty",
  /** The local default branch has commits the remote does not have, and the other way round; it has to be merged by hand. */
  "diverged",
  /** The local default branch has only commits the remote does not have (unpushed); the remote has nothing new. */
  "ahead",
  /** The default branch is checked out in another worktree of this repo; moving it would change that working directory underneath. */
  "checked-out-elsewhere",
]);
export type SyncSkipReason = z.infer<typeof SyncSkipReason>;

/**
 * The repo's working directory after the sync, so that the result says what is left for the user: the checked-out branch
 * (the default branch moves also when another is checked out, and then the files do not change) and uncommitted files,
 * which sync never touches.
 */
export const SyncWorkingTree = z.object({
  /** `null` on a detached HEAD. */
  branch: z.string().nullable(),
  /** Changed, added and deleted files git tracks. */
  changed: z.number().int().nonnegative(),
  /** New files git does not track yet. */
  untracked: z.number().int().nonnegative(),
});
export type SyncWorkingTree = z.infer<typeof SyncWorkingTree>;

/** What the sync did with the default branch. */
export const SyncBranchOutcome = z.discriminatedUnion("state", [
  /** The default branch moved to the remote one (`remoteBranch`, for example `origin/main`) by `commits` commits. */
  z.object({ state: z.literal("updated"), branch: z.string(), remoteBranch: z.string(), commits: z.number().int().positive() }),
  /** The fetch succeeded, and the default branch already equalled the remote one. */
  z.object({ state: z.literal("up-to-date"), branch: z.string(), remoteBranch: z.string() }),
  /** `message` is a sentence for the user, with the branch name when it is known. */
  z.object({ state: z.literal("skipped"), reason: SyncSkipReason, message: z.string() }),
]);
export type SyncBranchOutcome = z.infer<typeof SyncBranchOutcome>;

/**
 * The sync result of one repo without an error: what `vcs` returns, where a git error is an exception. `workingTree` is
 * `null` when `git status` after the sync failed: the branch has already moved anyway, so it is not a repo error.
 */
export const SyncResult = z.intersection(SyncBranchOutcome, z.object({ workingTree: SyncWorkingTree.nullable() }));
export type SyncResult = z.infer<typeof SyncResult>;

/** The sync result of one repo, once it has finished. */
export const SyncOutcome = z.union([
  SyncResult,
  /** Git refused (network, sign-in, host key, timeout); `message` is git's message. */
  z.object({ state: z.literal("failed"), message: z.string() }),
]);
export type SyncOutcome = z.infer<typeof SyncOutcome>;

const SyncTarget = z.object({
  /** The repo identifier when the sync started (ADR-18: it can change together with the directory name). */
  repo: z.string(),
  path: z.string(),
});

/** One repo in a sync: waiting for a free slot, running, or with a result. */
export const SyncRepo = z.union([SyncTarget.extend({ state: z.enum(["waiting", "running"]) }), z.intersection(SyncTarget, SyncOutcome)]);
export type SyncRepo = z.infer<typeof SyncRepo>;

export const SyncRun = z.object({
  /** ISO 8601. */
  startedAt: z.string(),
  /** ISO 8601; `null` while some repo is waiting or running. */
  finishedAt: z.string().nullable(),
  /** The repos of the projects folder when it started, in the order of the repo list. */
  repos: z.array(SyncRepo),
});
export type SyncRun = z.infer<typeof SyncRun>;
