import { type BranchTip, isAncestor } from "./commit-range.ts";
import { existingCommit, symbolicRef } from "./git.ts";
import { mainRemote, readConfig } from "./git-config.ts";
import { withoutHooks } from "./no-hooks.ts";
import { assertOwnGitDir } from "./own-git-dir.ts";
import type { RoundPlace } from "./round-commits.ts";
import { fetchRemote } from "./sync.ts";

/**
 * The git side of a task's refresh from its base branch (§4.4, ADR-245): the base branch's newest commit after a fetch,
 * and the merge commit that brings it into the task branch. The merge itself is built in memory in a scratch git
 * directory (`mergeIntoRepo` in `trial-merge.ts`), so no merge driver or attribute an agent could write into the repo
 * runs; only the commit and the move of the branch and the worktree run in the worktree, with its own git directory
 * checked (`own-git-dir.ts`) and without the repo's hooks, like a round commit (ADR-168).
 */

/** A checkout of many changed files with an LFS filter that fetches objects meanwhile. */
const CHECKOUT_TIMEOUT_MS = 5 * 60_000;

/**
 * The newest commit of `branch` after a fetch of the main remote: the remote's branch, unless the local one holds all
 * of it and more (commits the user has not pushed yet); the local branch in a repo without a remote or where the remote
 * has no such branch. `null` when neither exists. A failed fetch is an exception: an offline refresh would silently
 * merge an old commit.
 */
export async function freshBaseTip(repoDir: string, branch: string): Promise<BranchTip | null> {
  const config = await readConfig(repoDir);
  const remote = mainRemote(config);
  if (remote) await fetchRemote(repoDir, remote.name, { sshCommand: config.sshCommand });
  const local = await existingCommit(repoDir, `refs/heads/${branch}`);
  const fetched = remote ? await existingCommit(repoDir, `refs/remotes/${remote.name}/${branch}`) : undefined;
  const localTip = local === undefined ? null : { name: branch, commit: local };
  if (fetched === undefined || remote === undefined) return localTip;
  const remoteTip = { name: `${remote.name}/${branch}`, commit: fetched };
  if (local === undefined || local === fetched) return remoteTip;
  return (await isAncestor(repoDir, fetched, local)) ? localTip : remoteTip;
}

/**
 * Commits the merged `tree` on the task branch, with `head` and `theirs` as its parents, and moves the branch and the
 * worktree to it, only while HEAD is the task branch at `head`. `reset --keep` refuses rather than overwrite a file
 * changed since the caller's check; ignored files (builds) stay. The commit carries the user's own git identity and is
 * not signed, like a round commit.
 */
export async function commitMerge(place: RoundPlace, head: string, tree: string, theirs: string, message: string): Promise<string> {
  const own = await assertOwnGitDir(place);
  const dir = place.worktree;
  const [ref, now, config] = await Promise.all([symbolicRef(dir, "HEAD"), existingCommit(dir, "HEAD"), readConfig(dir)]);
  if (ref !== `refs/heads/${place.branch}` || now !== head) throw new Error("the worktree moved since the refresh was checked");
  return withoutHooks(async (hooksPath) => {
    const opts = { timeoutMs: CHECKOUT_TIMEOUT_MS, config: [hooksPath, "gc.auto=0"] };
    const made = await own(["commit-tree", "--no-gpg-sign", "-p", head, "-p", theirs, "-m", message, tree], opts);
    const commit = made.stdout.toString("utf8").trim();
    // An LFS filter may fetch objects during the checkout: an environment without prompts.
    await own(["reset", "--keep", "--quiet", commit, "--"], { ...opts, network: { sshCommand: config.sshCommand } });
    return commit;
  });
}
