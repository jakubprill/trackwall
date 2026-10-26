import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BranchOnRemote } from "@trackwall/protocol";
import { countBetween } from "./commit-range.ts";
import { existingCommit, git } from "./git.ts";
import { mainRemote, readConfig } from "./git-config.ts";
import { remoteAddress } from "./remote.ts";

/**
 * A task branch against the main remote and its push (ADR-77). The read compares only refs, as the last push or fetch
 * left them, without the network. The push is the only write to a server the daemon makes: one branch, by its full
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
 * Pushes `branch` to the main remote. Refused when the remote pushes elsewhere than it fetches from (`pushurl`,
 * `pushInsteadOf`): the user approved the repo host the panel names. Git updates the remote-tracking branch itself, so
 * the next read sees the push.
 */
export async function pushBranch(dir: string, branch: string): Promise<void> {
  const config = await readConfig(dir);
  const remote = mainRemote(config);
  if (!remote) throw new Error("the repo has neither an origin remote nor a single other remote");
  const pushUrl = (await git(dir, ["remote", "get-url", "--push", "--", remote.name])).stdout.toString("utf8").trim();
  if (address(pushUrl) !== address(remote.url))
    throw new Error(
      `${remote.name} pushes to ${address(pushUrl)}, not to ${address(remote.url)} it fetches from; Trackwall pushes only where it fetches from`,
    );
  const ref = `refs/heads/${branch}`;
  // Hooks run from `core.hooksPath`, which may point into the worktree (`.husky`): not only `pre-push`, which
  // `--no-verify` skips, but also `reference-transaction` when git updates the remote-tracking branch.
  const noHooks = mkdtempSync(join(tmpdir(), "trackwall-no-hooks-"));
  try {
    await git(dir, ["push", "--no-follow-tags", "--no-recurse-submodules", "--", remote.name, `${ref}:${ref}`], {
      timeoutMs: PUSH_TIMEOUT_MS,
      network: { sshCommand: config.sshCommand },
      config: [`core.hooksPath=${noHooks}`, `remote.${remote.name}.receivepack=git-receive-pack`],
    });
  } finally {
    rmSync(noHooks, { recursive: true, force: true });
  }
}

/**
 * A remote address compared and shown as `host/path`, so SSH and HTTPS spellings of one repo match and a token in a URL
 * never reaches a message; a local path as written.
 */
function address(url: string): string {
  return remoteAddress(url) ?? url;
}
