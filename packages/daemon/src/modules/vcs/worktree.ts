import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { git, knownDefaultBranch, revParse, symbolicRef } from "./git.ts";
import { mainRemote, readConfig } from "./git-config.ts";
import { parseStatus } from "./parse.ts";
import { pathKey } from "./path-key.ts";

/**
 * Agent task worktrees (§4.4, ADR-31): the task branch in a separate working directory (in the task worktrees folder, ADR-84),
 * what it starts from, what would be lost on its removal, and the removal itself. Functions get directories; which repo
 * and which worktree is known to the `agents` module. `worktree-changes.ts` counts worktree changes.
 */

/** `worktree add` fills the working directory, and an LFS filter may fetch objects meanwhile. */
const CHECKOUT_TIMEOUT_MS = 5 * 60_000;

/** What the task starts from: the repo's default branch (or the checked-out one when there is no default) and its commit. */
export interface WorktreeBase {
  branch: string | null;
  commit: string;
}

/**
 * The default branch without asking the server: from `refs/remotes/<remote>/HEAD`, the local one when it exists (sync
 * moves it, ADR-21, and unpushed commits may lie on it), otherwise the remote one. A repo without a remote or without
 * a default branch pointer gives the branch checked out in the repo, and a detached HEAD the bare commit.
 */
export async function defaultBase(dir: string): Promise<WorktreeBase> {
  const remote = mainRemote(await readConfig(dir));
  const branch = remote ? await knownDefaultBranch(dir, remote.name) : undefined;
  if (remote && branch) {
    const commit = (await revParse(dir, `refs/heads/${branch}`)) ?? (await revParse(dir, `refs/remotes/${remote.name}/${branch}`));
    if (commit) return { branch, commit };
  }
  const head = await revParse(dir, "HEAD");
  if (!head) throw new Error("the repo has no commits yet");
  const current = await symbolicRef(dir, "HEAD");
  return { branch: current?.startsWith("refs/heads/") ? current.slice("refs/heads/".length) : null, commit: head };
}

/**
 * A new branch `branch` from `commit` and its worktree in `path`; git refuses when the branch or the directory already exists.
 * Git creates the branch before the checkout and leaves it when the checkout fails (a busy directory, a filter, the time limit),
 * so a failed attempt cleans up its branch and directory; otherwise a retry with the same branch (approving the same
 * task proposal, ADR-39) would always end in "already exists". A branch that existed before the attempt is left alone.
 * `path` must lie in a task worktrees folder (ADR-84), because it is deleted without asking git.
 */
export async function addWorktree(repoDir: string, path: string, branch: string, commit: string): Promise<void> {
  if ((await revParse(repoDir, `refs/heads/${branch}`)) !== undefined) throw new Error(`a branch named '${branch}' already exists`);
  try {
    await git(repoDir, ["worktree", "add", "--quiet", "-b", branch, path, commit], { timeoutMs: CHECKOUT_TIMEOUT_MS });
  } catch (err) {
    // A failed cleanup (on Windows a file held by another process) goes into the error text: a retry
    // will then end in "already exists", and the user must know what to remove by hand.
    const leftovers: string[] = [];
    await removeWorktree(repoDir, path).catch((e: unknown) => leftovers.push(`directory ${path} (${String(e)})`));
    await deleteBranch(repoDir, branch).catch((e: unknown) => leftovers.push(`branch ${branch} (${String(e)})`));
    if (leftovers.length === 0) throw err;
    throw new Error(`${String(err)}; could not clean up, remove by hand: ${leftovers.join(", ")}`);
  }
}

/**
 * Removes a worktree together with uncommitted and ignored files (`--force`): the caller checked `pendingWork`
 * or the user confirmed the loss. Git drops the worktree registration before deleting files, so a removal
 * interrupted by a file held by another process (Windows) leaves a directory that is no longer a worktree; such a
 * directory, like every unregistered one (`pendingWork` reports it), we delete ourselves, and `prune` clears the
 * registration of a directory removed by hand. Without the repo (moved, a disconnected drive) only the directory
 * deletion remains, and the moved repo's `prune` clears the registration there.
 * `path` must lie in a task worktrees folder (ADR-84), because it is deleted without asking git.
 */
export async function removeWorktree(repoDir: string, path: string): Promise<void> {
  const repo = existsSync(repoDir);
  if (repo && existsSync(path) && (await isRegistered(repoDir, path))) {
    try {
      await git(repoDir, ["worktree", "remove", "--force", path], { timeoutMs: CHECKOUT_TIMEOUT_MS });
    } catch (err) {
      if (await isRegistered(repoDir, path)) throw err;
    }
  }
  await rm(path, { recursive: true, force: true, maxRetries: 3 });
  if (repo) await git(repoDir, ["worktree", "prune"]);
}

/** Whether `path` is a worktree of the repo according to `git worktree list`. */
async function isRegistered(repoDir: string, path: string): Promise<boolean> {
  const { stdout } = await git(repoDir, ["worktree", "list", "--porcelain"]);
  const target = await pathKey(path);
  const listed = stdout
    .toString("utf8")
    .split("\n")
    .filter((line) => line.startsWith("worktree "));
  for (const line of listed) if ((await pathKey(line.slice("worktree ".length))) === target) return true;
  return false;
}

/** Deletes a branch whether or not it is merged; a branch that no longer exists (also without the repo) has nothing to delete. */
export async function deleteBranch(repoDir: string, branch: string): Promise<void> {
  if (!existsSync(repoDir) || (await revParse(repoDir, `refs/heads/${branch}`)) === undefined) return;
  await git(repoDir, ["branch", "--quiet", "-D", branch]);
}

/** A branch in a worktree: the repo with the branch, the worktree directory and the commit the branch started from. */
export interface WorktreeBranch {
  repoDir: string;
  worktree: string;
  branch: string;
  base: string;
}

/** What would be lost on removing the worktree, and without the branch also on deleting the branch. */
export interface PendingWork {
  /** The worktree's `git status` entries, each new file separately. */
  uncommitted: number;
  /** Worktree HEAD commits that are on no branch or tag (a detached HEAD): they vanish with the worktree. */
  strayCommits: number;
  /** The branch's commits since `base`. */
  branchCommits: number;
  /**
   * The worktree directory is on disk, but git does not know it (an interrupted removal, `worktree prune`, a repo cloned
   * again or a repo that no longer exists), so what is in it cannot be counted; removal deletes it entirely.
   */
  unregisteredDir: boolean;
}

/** A worktree removed by hand has nothing to lose; neither does a branch deleted by hand. */
export async function pendingWork(work: WorktreeBranch): Promise<PendingWork> {
  const onDisk = existsSync(work.worktree);
  if (!existsSync(work.repoDir)) return { uncommitted: 0, strayCommits: 0, branchCommits: 0, unregisteredDir: onDisk };
  const branchRef = `refs/heads/${work.branch}`;
  const registered = onDisk && (await isRegistered(work.repoDir, work.worktree));
  const [uncommitted, strayCommits, branchCommits] = await Promise.all([
    registered ? uncommittedCount(work.worktree) : 0,
    registered ? count(work.worktree, ["HEAD", "--not", "--branches", "--tags", "--remotes"]) : 0,
    revParse(work.repoDir, branchRef).then((tip) => (tip ? commitCount(work.repoDir, work.base, branchRef) : 0)),
  ]);
  return { uncommitted, strayCommits, branchCommits, unregisteredDir: onDisk && !registered };
}

export async function uncommittedCount(dir: string): Promise<number> {
  const { stdout } = await git(dir, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
  return parseStatus(stdout.toString("utf8")).changes;
}

export function commitCount(dir: string, from: string, to: string): Promise<number> {
  return count(dir, [`${from}..${to}`]);
}

async function count(dir: string, revs: string[]): Promise<number> {
  const { stdout } = await git(dir, ["rev-list", "--count", ...revs, "--"]);
  return Number(stdout.toString("utf8").trim());
}
