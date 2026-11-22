import type { NewTaskBase } from "@trackwall/protocol";
import { revParse } from "./git.ts";
import { readConfig } from "./git-config.ts";
import { lastFetch } from "./git-dir.ts";
import { divergence, knownDefaultTarget } from "./sync.ts";

/**
 * Where a new task of the repo starts, against the server (§4.4, ADR-296): the local default branch, which `defaultBase`
 * gives a task, against the remote-tracking branch a sync moves it to, as of the repo's last fetch. Only refs are read;
 * nothing is fetched. `null` when there is nothing to compare: no main remote, or no default branch pointer that resolves.
 * Without a local default branch the task starts from the remote-tracking one, so it lacks nothing.
 */
export async function newTaskBase(dir: string): Promise<NewTaskBase | null> {
  const known = await knownDefaultTarget(dir, await readConfig(dir));
  if (known === undefined) return null;
  const { branch, remoteRef, remoteBranch } = known.target;
  const localRef = `refs/heads/${branch}`;
  const [counts, fetchedAt] = await Promise.all([
    revParse(dir, localRef).then((local) => (local === undefined ? { ahead: 0, behind: 0 } : divergence(dir, localRef, remoteRef))),
    // A `FETCH_HEAD` that cannot be read this time (a network drive's timeout) leaves only the time out, as in the repo status.
    lastFetch(dir).catch(() => null),
  ]);
  return { branch, remoteBranch, ...counts, fetchedAt };
}
