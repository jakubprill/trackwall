import { existingCommit, symbolicRef } from "./git.ts";
import { readConfig, remoteUrl } from "./git-config.ts";
import { networkAddress } from "./remote.ts";
import { serverTip } from "./remote-reach.ts";
import { trackedBranch } from "./tracked-branch.ts";

/**
 * One repo's part of the server check (§4.5, ADR-295): whether the server has moved the branch the checked-out branch
 * tracks since the repo's last fetch, i.e. whether a fetch would bring something. The repo itself is only read (its
 * HEAD, the branch's configuration, its remote-tracking ref); the server is asked from outside the repo, in a folder of
 * `questionsDir` (`remote-reach.ts`), so nothing the repo's configuration names runs, and nothing is fetched or written.
 *
 * `null` when there is nothing to compare: a detached HEAD, a branch that tracks no branch or a local one, a remote that
 * is no HTTPS or SSH address, or a remote-tracking ref the repo never fetched (its row says the branch tracks no remote
 * branch, and a pull fetches it). A branch the server no longer has is no new commits: a pull says that it is gone.
 * Throws git's message when the server does not answer.
 */
export async function newOnServer(dir: string, questionsDir: string): Promise<boolean | null> {
  const head = await symbolicRef(dir, "HEAD");
  if (!head?.startsWith("refs/heads/")) return null;
  const tracked = await trackedBranch(dir, head);
  if (tracked === undefined || tracked.remote === ".") return null;
  const url = remoteUrl(await readConfig(dir), tracked.remote);
  if (url === undefined || networkAddress(url) === undefined) return null;
  const fetched = await existingCommit(dir, tracked.ref);
  if (fetched === undefined) return null;
  const tip = await serverTip(url, tracked.remoteRef, questionsDir);
  return tip !== null && tip !== fetched;
}
