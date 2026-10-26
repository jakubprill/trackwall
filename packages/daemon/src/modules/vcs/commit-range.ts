import type { Commit } from "@trackwall/protocol";
import { existingCommit, git, knownDefaultBranch, revParse } from "./git.ts";
import { mainRemote, readConfig } from "./git-config.ts";
import { LOG_FORMAT, parseLog } from "./parse.ts";

/**
 * What came onto a branch between two commits, for the day report (ADR-70): the remote default branch as the last fetch
 * left it, and the commits from an older commit to a newer one. Only reads refs and objects, never the network. Between
 * two commits a git error is an exception, so a timeout is never mistaken for a rewritten history; a remote default
 * branch git cannot read is `null`, like a missing one, which leaves the day start's compared commit as it was.
 */

/** The main remote's default branch, e.g. `origin/main`, and its commit. */
export interface BranchTip {
  name: string;
  commit: string;
}

/** The commits on one commit that another does not have: how many, and the newest of them, newest first. */
export interface CommitRange {
  total: number;
  commits: Commit[];
}

/** The main remote's default branch and its commit; `null` without a remote or a known default branch. */
export async function remoteDefaultBranch(dir: string): Promise<BranchTip | null> {
  const remote = mainRemote(await readConfig(dir));
  if (!remote) return null;
  const branch = await knownDefaultBranch(dir, remote.name);
  if (branch === undefined) return null;
  const commit = await revParse(dir, `refs/remotes/${remote.name}/${branch}`);
  return commit === undefined ? null : { name: `${remote.name}/${branch}`, commit };
}

/** `ancestor` is in the history of `commit`; `false` also when `ancestor` is not in the repo (gone after a force push and `gc`). */
export async function isAncestor(dir: string, ancestor: string, commit: string): Promise<boolean> {
  if ((await existingCommit(dir, ancestor)) === undefined) return false;
  // Not `merge-base --is-ancestor`: it answers with its exit code, which the runner cannot tell from a git error.
  return (await count(dir, [`^${commit}`, ancestor])) === 0;
}

/** How many commits `to` has that `from` does not; `undefined` when `from` is not in the repo. */
export async function countBetween(dir: string, from: string, to: string): Promise<number | undefined> {
  if ((await existingCommit(dir, from)) === undefined) return undefined;
  return count(dir, [`^${from}`, to]);
}

/** The commits `to` has that `from` does not, with the newest `limit` of them; `undefined` when `from` is not in the repo. */
export async function commitsBetween(dir: string, from: string, to: string, limit: number): Promise<CommitRange | undefined> {
  if ((await existingCommit(dir, from)) === undefined) return undefined;
  const range = [`^${from}`, to];
  const [total, commits] = await Promise.all([count(dir, range), log(dir, range, limit)]);
  return { total, commits };
}

/** The newest `limit` commits of `commit`'s history, newest first. */
export function newestCommits(dir: string, commit: string, limit: number): Promise<Commit[]> {
  return log(dir, [commit], limit);
}

async function log(dir: string, range: readonly string[], limit: number): Promise<Commit[]> {
  const { stdout } = await git(dir, ["log", "-z", `--max-count=${limit}`, LOG_FORMAT, ...range, "--"]);
  return parseLog(stdout.toString("utf8"));
}

async function count(dir: string, range: readonly string[]): Promise<number> {
  const out = (await git(dir, ["rev-list", "--count", ...range, "--"])).stdout.toString("utf8").trim();
  const total = Number(out);
  if (out === "" || !Number.isInteger(total)) throw new Error(`unexpected git rev-list output: ${out}`);
  return total;
}
