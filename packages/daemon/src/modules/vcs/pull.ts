import type { PullBranchOutcome, PullResult, PullSkipReason } from "@trackwall/protocol";
import { knownDefaultBranch, revParse, symbolicRef } from "./git.ts";
import { mainRemote, readConfig } from "./git-config.ts";
import { bringBack, changedTrackedFiles, describePutAside, putAside } from "./put-aside.ts";
import { fastForward, fetchRemote, syncDefaultBranch, workingTree } from "./sync.ts";
import { trackedBranch } from "./tracked-branch.ts";

/**
 * A pull of one repo from its header (§4.5, ADR-269): the sync of the default branch exactly as "Sync all" does it
 * (ADR-21), then a fast-forward of the checked-out branch to the branch it tracks, under the same rules. "Sync all"
 * leaves the checked-out branch alone when it is not the default one, and its fetch is what makes the header show
 * commits to pull, so this is the one place that moves it, and only on the user's click. Nothing here merges, rebases,
 * pushes or touches changes in the working directory; each such case is a skip with a reason, and a git error an exception.
 */

const HEADS = "refs/heads/";

/**
 * With `putAside`, changes in tracked files are first moved into a stash (ADR-271), and brought back when the pull then
 * does not move the checked-out branch (skipped or already up to date) or fails, so they are put aside only for a pull that happened.
 */
export async function pullRepo(dir: string, options: { putAside: boolean }): Promise<PullResult> {
  const stash = options.putAside && (await changedTrackedFiles(dir)).length > 0 ? await putAside(dir) : undefined;
  let outcome: Pick<PullResult, "defaultBranch" | "checkedOut">;
  try {
    outcome = await pullBranches(dir);
  } catch (err) {
    if (stash) await bringBack(dir, stash);
    throw err;
  }
  const moved = (outcome.checkedOut ?? outcome.defaultBranch).state === "updated";
  if (stash && !moved) await bringBack(dir, stash);
  const kept = stash && moved ? await describePutAside(dir, stash) : null;
  return { ...outcome, workingTree: await workingTree(dir), putAside: kept };
}

async function pullBranches(dir: string): Promise<Pick<PullResult, "defaultBranch" | "checkedOut">> {
  const defaultBranch = await syncDefaultBranch(dir);
  return { defaultBranch, checkedOut: await pullCheckedOut(dir) };
}

/** `null` when the checked-out branch is the default branch, which the sync has just handled. */
async function pullCheckedOut(dir: string): Promise<PullBranchOutcome | null> {
  const head = await symbolicRef(dir, "HEAD");
  if (!head?.startsWith(HEADS)) return skipped("detached", "no branch is checked out, so there is nothing to pull into");
  const branch = head.slice(HEADS.length);
  const config = await readConfig(dir);
  const main = mainRemote(config);
  if (main && branch === (await knownDefaultBranch(dir, main.name))) return null;

  const upstream = await trackedBranch(dir, head);
  if (upstream === undefined) return skipped("no-upstream", `${branch} tracks no branch`);
  const network = { sshCommand: config.sshCommand };
  // The sync fetched the main remote; a branch that tracks another one (a fork's `upstream`) needs its own fetch, and one
  // that tracks a local branch (remote `.`) none.
  if (upstream.remote !== "." && upstream.remote !== main?.name) await fetchRemote(dir, upstream.remote, network);
  if ((await revParse(dir, upstream.ref)) === undefined)
    return skipped("no-upstream", `${upstream.short}, which ${branch} tracks, is gone`);
  return fastForward(dir, { branch, remoteRef: upstream.ref, remoteBranch: upstream.short }, network);
}

function skipped(reason: PullSkipReason, message: string): PullBranchOutcome {
  return { state: "skipped", reason, message };
}
