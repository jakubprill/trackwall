import type { Commit } from "@trackwall/protocol";
import { git, knownDefaultBranch, revParse } from "./git.ts";
import { mainRemote, readConfig } from "./git-config.ts";
import { LOG_FORMAT, parseLog } from "./parse.ts";

/**
 * What came onto a branch between two commits, for the day report (ADR-70): the remote default branch as the last fetch
 * left it, and the commits from an older commit to a newer one. Only reads refs and objects, never the network.
 */

/** The main remote's default branch (`origin/main`) and its commit; `null` without a remote or a known default branch. */
export async function remoteDefaultBranch(dir: string): Promise<{ name: string; commit: string } | null> {
  const remote = mainRemote(await readConfig(dir));
  if (!remote) return null;
  const branch = await knownDefaultBranch(dir, remote.name);
  if (branch === undefined) return null;
  const commit = await revParse(dir, `refs/remotes/${remote.name}/${branch}`);
  return commit === undefined ? null : { name: `${remote.name}/${branch}`, commit };
}

/** `ancestor` is in the history of `commit`; `false` also when `ancestor` is not in the repo (gone after a force push and `gc`). */
export async function isAncestor(dir: string, ancestor: string, commit: string): Promise<boolean> {
  // Exit code 1 means "not an ancestor" and 128 "no such commit"; both are an exception from `git`.
  return git(dir, ["merge-base", "--is-ancestor", ancestor, commit]).then(
    () => true,
    () => false,
  );
}

/**
 * The commits reachable from `to` but not from `from` (`null`: all of `to`'s history): how many, and the newest `limit`
 * of them, newest first. `undefined` when `from` is not in the repo.
 */
export async function commitsBetween(
  dir: string,
  from: string | null,
  to: string,
  limit: number,
): Promise<{ total: number; commits: Commit[] } | undefined> {
  if (from !== null && (await revParse(dir, from)) === undefined) return undefined;
  const range = from === null ? [to] : [`^${from}`, to];
  const [count, log] = await Promise.all([
    git(dir, ["rev-list", "--count", ...range, "--"]),
    limit === 0 ? undefined : git(dir, ["log", "-z", `--max-count=${limit}`, LOG_FORMAT, ...range, "--"]),
  ]);
  const total = Number(count.stdout.toString("utf8").trim());
  if (!Number.isInteger(total)) throw new Error(`unexpected git rev-list output: ${count.stdout.toString("utf8").trim()}`);
  return { total, commits: log === undefined ? [] : parseLog(log.stdout.toString("utf8")) };
}
