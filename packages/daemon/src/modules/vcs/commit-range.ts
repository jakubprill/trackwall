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

/**
 * The newest commit on `head`'s first-parent line that is not one of `skip`; `null` when every commit it looked at is.
 * A task's round commits (ADR-168) sit on top of the agent's own, so this is the newest commit the agent made itself or
 * the one its task started from (ADR-144).
 */
export async function newestCommitBesides(dir: string, head: string, skip: ReadonlySet<string>): Promise<string | null> {
  if (!skip.has(head)) return head;
  const { stdout } = await git(dir, ["rev-list", "--first-parent", `--max-count=${skip.size + 1}`, head, "--"]);
  const commits = stdout
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim());
  return commits.find((commit) => commit !== "" && !skip.has(commit)) ?? null;
}

/** Whether two commits hold the same files; `false` when `a` is not in the repo (gone after a rewrite and `gc`). */
export async function sameTree(dir: string, a: string, b: string): Promise<boolean> {
  // One process for both; git exits with 128 when it cannot name one of them, which leaves no two equal trees.
  const { stdout } = await git(dir, ["rev-parse", `${a}^{tree}`, `${b}^{tree}`, "--"], { okExitCodes: [128] });
  const [treeA, treeB] = stdout.toString("utf8").split("\n");
  return treeA !== undefined && /^[0-9a-f]{40,64}$/.test(treeA) && treeA === treeB;
}

/** The commits `to` has that `from` does not, with the newest `limit` of them; `undefined` when `from` is not in the repo. */
export async function commitsBetween(dir: string, from: string, to: string, limit: number): Promise<CommitRange | undefined> {
  if ((await existingCommit(dir, from)) === undefined) return undefined;
  const range = [`^${from}`, to];
  const [total, commits] = await Promise.all([count(dir, range), log(dir, range, limit)]);
  return { total, commits };
}

/**
 * The paths that differ between two commits, at most `max` of them, only under `pathspecs` when given (git pathspecs,
 * where `*` also matches `/`); `undefined` when `from` is not in the repo.
 */
export async function changedPathsBetween(
  dir: string,
  from: string,
  to: string,
  max: number,
  pathspecs: readonly string[] = [],
): Promise<{ paths: string[]; truncated: boolean } | undefined> {
  if ((await existingCommit(dir, from)) === undefined) return undefined;
  const { stdout } = await git(dir, ["diff", "--name-only", "-z", "--no-renames", from, to, "--", ...pathspecs]);
  const paths = stdout
    .toString("utf8")
    .split("\0")
    .filter((path) => path !== "");
  return { paths: paths.slice(0, max), truncated: paths.length > max };
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
