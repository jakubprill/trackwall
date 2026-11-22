import { existingCommit, symbolicRef } from "./git.ts";
import { type GitConfig, readConfig, remoteUrl } from "./git-config.ts";
import { networkAddress } from "./remote.ts";
import { serverTips } from "./remote-reach.ts";
import { knownDefaultTarget } from "./sync.ts";
import { trackedBranch } from "./tracked-branch.ts";

/**
 * One repo's part of the server check (§4.5, ADR-295, ADR-297): the remote-tracking branches the server has moved past
 * since the repo's last fetch, i.e. what a fetch would bring, out of two: the one the checked-out branch tracks, which a
 * pull fast-forwards it to, and the main remote's default branch, where a new task starts. The repo itself is only read
 * (its HEAD, the branch's configuration, its remote-tracking refs); each server is asked once, from outside the repo, in a
 * folder of `questionsDir` (`remote-reach.ts`), so nothing the repo's configuration names runs, and nothing is fetched or
 * written.
 *
 * A branch is left out when there is nothing to compare: a detached HEAD, a branch that tracks no branch or a local one, a
 * remote that is no HTTPS or SSH address, or a remote-tracking ref the repo never fetched (its row says the branch tracks
 * no remote branch, and a pull fetches it). A branch the server no longer has is no new commits: a pull says that it is
 * gone. Throws git's message when a server does not answer.
 */
export async function newOnServer(dir: string, questionsDir: string): Promise<string[]> {
  const byUrl = new Map<string, AskedBranch[]>();
  for (const asked of await branchesToAsk(dir)) byUrl.set(asked.url, [...(byUrl.get(asked.url) ?? []), asked]);
  const moved = await Promise.all(
    [...byUrl].map(async ([url, branches]) => {
      const tips = await serverTips(
        url,
        branches.map((b) => b.serverRef),
        questionsDir,
      );
      return branches.filter((b) => {
        const tip = tips.get(b.serverRef);
        return tip !== undefined && tip !== b.fetched;
      });
    }),
  );
  return moved.flat().map((b) => b.name);
}

/** A remote-tracking branch the check can ask the server about. */
interface RemoteBranch {
  /** The remote-tracking ref, `refs/remotes/origin/main`. */
  ref: string;
  /** The same, short: `origin/main`. */
  name: string;
  /** The remote's address. */
  url: string;
  /** The branch's name on the server, `refs/heads/main`. */
  serverRef: string;
}

/** A remote-tracking branch with the commit the last fetch left in it. */
type AskedBranch = RemoteBranch & { fetched: string };

/** The remote-tracking branch the checked-out branch tracks and the main remote's default branch, each once. */
async function branchesToAsk(dir: string): Promise<AskedBranch[]> {
  const config = await readConfig(dir);
  const asked = new Map<string, AskedBranch>();
  for (const branch of await Promise.all([trackedByHead(dir, config), defaultOfMainRemote(dir, config)])) {
    if (branch === undefined || asked.has(branch.ref) || networkAddress(branch.url) === undefined) continue;
    const fetched = await existingCommit(dir, branch.ref);
    if (fetched !== undefined) asked.set(branch.ref, { ...branch, fetched });
  }
  return [...asked.values()];
}

/** What the checked-out branch tracks on a remote. */
async function trackedByHead(dir: string, config: GitConfig): Promise<RemoteBranch | undefined> {
  const head = await symbolicRef(dir, "HEAD");
  if (!head?.startsWith("refs/heads/")) return undefined;
  const tracked = await trackedBranch(dir, head);
  if (tracked === undefined || tracked.remote === ".") return undefined;
  const url = remoteUrl(config, tracked.remote);
  return url === undefined ? undefined : { ref: tracked.ref, name: tracked.short, url, serverRef: tracked.remoteRef };
}

/** The main remote's default branch, where a new task starts (ADR-297), as `defaultBase` knows it. */
async function defaultOfMainRemote(dir: string, config: GitConfig): Promise<RemoteBranch | undefined> {
  const known = await knownDefaultTarget(dir, config);
  if (known === undefined) return undefined;
  const { branch, remoteRef, remoteBranch } = known.target;
  return { ref: remoteRef, name: remoteBranch, url: known.url, serverRef: `refs/heads/${branch}` };
}
