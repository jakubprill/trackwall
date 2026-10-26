import { countBetween } from "./commit-range.ts";
import { existingCommit, git } from "./git.ts";
import { mainRemote, readConfig } from "./git-config.ts";

/**
 * A task branch against the main remote and its push (ADR-77). The read compares only refs, as the last push or fetch
 * left them, without the network. The push is the only write to a server the daemon makes: one branch, by its full
 * name on both sides, never forced, so a remote that moved on refuses it and nothing is lost there.
 */

/** A push of a large branch over VPN takes a while; longer is more likely a connection that hangs. */
const PUSH_TIMEOUT_MS = 5 * 60_000;

export interface BranchOnRemote {
  remote: string;
  published: boolean;
  unpushed: number;
  behind: number;
}

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
 * Pushes `branch` to the main remote. Without the repo's push hooks (`--no-verify`): a hook can live in the worktree
 * (`core.hooksPath` such as `.husky`), where the task's agent writes, and the daemon runs nothing the agent wrote
 * without the user reading it (§8). Git updates the remote-tracking branch itself, so the next read sees the push.
 */
export async function pushBranch(dir: string, branch: string): Promise<void> {
  const config = await readConfig(dir);
  const remote = mainRemote(config);
  if (!remote) throw new Error("the repo has neither an origin remote nor a single other remote");
  const ref = `refs/heads/${branch}`;
  await git(dir, ["push", "--no-verify", "--", remote.name, `${ref}:${ref}`], {
    timeoutMs: PUSH_TIMEOUT_MS,
    network: { sshCommand: config.sshCommand },
  });
}
