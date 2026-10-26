import type { BranchOnRemote } from "@trackwall/protocol";
import { countBetween } from "./commit-range.ts";
import { existingCommit, git } from "./git.ts";
import { mainRemote, readConfig } from "./git-config.ts";
import { withoutHooks } from "./no-hooks.ts";
import { networkAddress } from "./remote.ts";

/**
 * A task branch against the main remote and its push (ADR-77). The read compares only refs, as the last push or fetch
 * left them, without the network. The push is one of the daemon's two writes to a server (the other is the local config store's, ADR-86): one branch, by its full
 * name on both sides, never forced, so a remote that moved on refuses it and nothing is lost there. The task's agent
 * shares the repo's configuration and writes in the worktree, so the push takes from neither what it could plant: no
 * hooks, no tags or submodules, no other receiving program, and no push address other than the one the panel shows (§8).
 */

/** A push of a large branch over VPN takes a while; longer is more likely a connection that hangs. */
const PUSH_TIMEOUT_MS = 5 * 60_000;

/** `branch` against the main remote's branch of the same name; `null` without a main remote. */
export async function branchOnRemote(dir: string, branch: string, base: string): Promise<BranchOnRemote | null> {
  const remote = mainRemote(await readConfig(dir));
  if (!remote) return null;
  const local = `refs/heads/${branch}`;
  const tracking = `refs/remotes/${remote.name}/${branch}`;
  if ((await existingCommit(dir, tracking)) === undefined)
    return { remote: remote.name, published: false, unpushed: (await countBetween(dir, base, local)) ?? 0, behind: 0 };
  const [unpushed, behind] = await Promise.all([countBetween(dir, tracking, local), countBetween(dir, local, tracking)]);
  return { remote: remote.name, published: true, unpushed: unpushed ?? 0, behind: behind ?? 0 };
}

/**
 * Pushes `branch` to the main remote. Refused unless every address git would push to (`pushurl`s, or every `url` without
 * one, after `pushInsteadOf`) is the address it fetches from, over HTTPS or SSH: the user approved the repo host the panel
 * names, and a local path, `ext::` or `git://` would let configuration run a program or reach a repo the agent wrote.
 * Git updates the remote-tracking branch itself, so the next read sees the push.
 */
export async function pushBranch(dir: string, branch: string): Promise<void> {
  const config = await readConfig(dir);
  const remote = mainRemote(config);
  if (!remote) throw new Error("the repo has neither an origin remote nor a single other remote");
  const fetchesFrom = networkAddress(remote.url);
  if (fetchesFrom === undefined)
    throw new Error(`${remote.name} is not an HTTPS or SSH address of a repo host; Trackwall pushes only to one`);
  const { stdout } = await git(dir, ["remote", "get-url", "--push", "--all", "--", remote.name]);
  const pushesTo = stdout
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim() !== "");
  const elsewhere = pushesTo.map((url) => networkAddress(url.trim()) ?? "a local or unusual address").find((to) => to !== fetchesFrom);
  if (elsewhere !== undefined)
    throw new Error(
      `${remote.name} pushes to ${elsewhere}, not to ${fetchesFrom} it fetches from; Trackwall pushes only where it fetches from`,
    );
  const ref = `refs/heads/${branch}`;
  await withoutHooks((hooksPath) =>
    git(dir, ["push", "--no-follow-tags", "--no-recurse-submodules", "--", remote.name, `${ref}:${ref}`], {
      timeoutMs: PUSH_TIMEOUT_MS,
      network: { sshCommand: config.sshCommand },
      config: [hooksPath, `remote.${remote.name}.receivepack=git-receive-pack`, "push.gpgSign=false"],
    }),
  );
}
