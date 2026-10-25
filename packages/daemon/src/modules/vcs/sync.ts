import {
  countLabel,
  type SyncBranchOutcome,
  type SyncResult,
  type SyncSkipReason,
  type SyncWorkingTree,
  trackedChanges,
} from "@trackwall/protocol";
import { type GitNetwork, git, knownDefaultBranch, revParse } from "./git.ts";
import { mainRemote, readConfig } from "./git-config.ts";
import { parseStatus } from "./parse.ts";

/**
 * Sync of one repo (§4.5, ADR-21): `git fetch` of the main remote, then a fast-forward of the local default branch
 * to the remote one, and nothing else. It does not merge, rebase, switch branches or touch a working directory
 * with changes; each such case is a skip with a reason, and a git error is an exception. Every result also
 * says what is left in the working directory (ADR-34), because "up to date" with four changed files, or a moved
 * default branch while another one is checked out, look without it like a sync that did nothing.
 */

/**
 * A fetch of a large repo over VPN takes minutes; longer is more likely a hung connection. Killing git after the limit does not
 * break the repo: fetch writes refs only at the end.
 */
const FETCH_TIMEOUT_MS = 5 * 60_000;

/** A fast-forward of the checked-out branch updates files in the working directory; a large repo with LFS fetches objects meanwhile. */
const MERGE_TIMEOUT_MS = 5 * 60_000;

export async function syncRepo(dir: string): Promise<SyncResult> {
  const outcome = await syncDefaultBranch(dir);
  return { ...outcome, workingTree: await workingTree(dir) };
}

async function syncDefaultBranch(dir: string): Promise<SyncBranchOutcome> {
  const config = await readConfig(dir);
  const remote = mainRemote(config);
  if (!remote) return skipped("no-remote", "the repo has neither an origin remote nor a single other remote");
  const network = { sshCommand: config.sshCommand };
  await git(dir, ["fetch", "--quiet", "--", remote.name], { timeoutMs: FETCH_TIMEOUT_MS, network });
  const branch = await defaultBranch(dir, remote.name, network);
  if (branch === undefined)
    return skipped("no-default-branch", `${remote.name} does not point to a default branch (git remote set-head ${remote.name} --auto)`);
  return fastForward(dir, branch, remote.name, network);
}

/**
 * The default branch of the remote repo from `refs/remotes/<remote>/HEAD`, which `git clone` sets. When it is missing (a repo
 * from `git init` and `remote add`) or points to a branch that no longer exists (the repo host changed the default branch and a
 * fetch with `prune` removed the old one), one question to the server (`remote set-head --auto`). The daemon does not detect a
 * change of default branch whose old branch still exists unless it asks the server on every sync.
 */
async function defaultBranch(dir: string, remote: string, network: GitNetwork): Promise<string | undefined> {
  const read = () => knownDefaultBranch(dir, remote);
  const known = await read();
  if (known !== undefined) return known;
  try {
    await git(dir, ["remote", "set-head", "--auto", "--", remote], {
      timeoutMs: FETCH_TIMEOUT_MS,
      network,
    });
  } catch {
    return undefined;
  }
  return read();
}

async function fastForward(dir: string, branch: string, remote: string, network: GitNetwork): Promise<SyncBranchOutcome> {
  const localRef = `refs/heads/${branch}`;
  const remoteRef = `refs/remotes/${remote}/${branch}`;
  const remoteBranch = `${remote}/${branch}`;
  if ((await revParse(dir, localRef)) === undefined)
    return skipped("no-local-branch", `branch ${branch} does not exist locally; only fetched the changes`);
  const { ahead, behind } = await divergence(dir, localRef, remoteRef);
  if (ahead > 0 && behind > 0)
    return skipped("diverged", `${branch} has diverged from the remote (${ahead} local, ${behind} remote); merge by hand`);
  if (ahead > 0) return skipped("ahead", `${branch} has ${countLabel(ahead, { one: "unpushed commit", other: "unpushed commits" })}`);
  if (behind === 0) return { state: "up-to-date", branch, remoteBranch };

  const status = parseStatus(
    (await git(dir, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=no"])).stdout.toString("utf8"),
  );
  if (status.branch === branch) {
    if (status.changes > 0) return skipped("dirty", `${branch} is checked out and has uncommitted changes`);
    // Moving the checked-out branch must also update the working directory; `--ff-only` refuses instead of overwriting
    // an untracked file that is in the way. An LFS filter may fetch objects meanwhile, hence the network environment.
    await git(dir, ["merge", "--ff-only", "--quiet", remoteRef], {
      timeoutMs: MERGE_TIMEOUT_MS,
      network,
    });
  } else {
    if (await checkedOutInWorktree(dir, localRef))
      return skipped("checked-out-elsewhere", `${branch} is checked out in another worktree of this repo`);
    // A fetch from the current repo without `+` accepts only a fast-forward and refuses when the branch is in use in some
    // worktree even without being checked out (a rebase or bisect in progress), which `worktree list` does not show. Without
    // submodules (the user's `submodule.recurse` would fetch them a second time from the network) and without overwriting `FETCH_HEAD`.
    await git(dir, ["fetch", "--quiet", "--no-recurse-submodules", "--no-write-fetch-head", ".", `${remoteRef}:${localRef}`]);
  }
  return { state: "updated", branch, remoteBranch, commits: behind };
}

/** How many commits only the local branch has (`ahead`), and how many only the remote one (`behind`). */
async function divergence(dir: string, localRef: string, remoteRef: string): Promise<{ ahead: number; behind: number }> {
  const { stdout } = await git(dir, ["rev-list", "--left-right", "--count", `${localRef}...${remoteRef}`]);
  const m = /^(\d+)\s+(\d+)/.exec(stdout.toString("utf8").trim());
  if (!m) throw new Error(`unexpected git rev-list output: ${stdout.toString("utf8").trim()}`);
  return { ahead: Number(m[1]), behind: Number(m[2]) };
}

/**
 * Whether the branch is checked out in some worktree; called when it is not in the current one, so it is about another worktree.
 * Lines instead of `-z`, which git has only since 2.36.
 */
async function checkedOutInWorktree(dir: string, localRef: string): Promise<boolean> {
  const { stdout } = await git(dir, ["worktree", "list", "--porcelain"]);
  return stdout
    .toString("utf8")
    .split("\n")
    .some((line) => line === `branch ${localRef}`);
}

/**
 * The checked-out branch and uncommitted files after sync; untracked ones separately, because they never block it. An error is
 * `null`, not an exception: after a moved branch (an antivirus on Windows scans new files) `git status` can
 * exceed the limit, and the sync succeeded anyway.
 */
async function workingTree(dir: string): Promise<SyncWorkingTree | null> {
  try {
    const status = parseStatus((await git(dir, ["status", "--porcelain=v2", "--branch", "-z"])).stdout.toString("utf8"));
    return { branch: status.branch, changed: trackedChanges(status), untracked: status.untracked };
  } catch {
    return null;
  }
}

function skipped(reason: SyncSkipReason, message: string): SyncBranchOutcome {
  return { state: "skipped", reason, message };
}
