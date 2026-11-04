import { tmpdir } from "node:os";
import { git } from "./git.ts";
import { mainRemote, readConfig } from "./git-config.ts";
import { networkAddress } from "./remote.ts";

/**
 * Whether git reaches a repo's main remote with the user's own sign-in (ADR-195): `git ls-remote` of the remote's address,
 * with the environment without prompts a sync's fetch has, so a missing SSH key, an unknown host key or a missing sign-in
 * fails at once instead of hanging. It runs outside the repo, on the address the repo's configuration resolves to, so
 * only the user's and the system's configuration apply: the doctor runs it whenever Settings opens, and a repo's own
 * configuration, which a task's agent can write, must not run a program then (`core.sshCommand`, a credential helper,
 * `uploadpack`). That is also the sign-in the check is about. It reads only the remote's refs; nothing is written.
 */

/** A remote that answers does so in a second or two, also over a VPN; the doctor's report waits for the slowest host. */
const REACH_TIMEOUT_MS = 8_000;

/** The main remote's HTTPS or SSH address as `host/path`; `null` for anything else (a local folder, `git://`). */
export async function networkRemote(dir: string): Promise<{ url: string; address: string } | null> {
  const remote = mainRemote(await readConfig(dir));
  const address = remote && networkAddress(remote.url);
  return remote && address !== undefined ? { url: remote.url, address } : null;
}

/** Throws git's message when the remote at `url` (an HTTPS or SSH address) does not answer with the user's sign-in. */
export async function reachRemote(url: string): Promise<void> {
  if (networkAddress(url) === undefined) throw new Error(`${url} is not an HTTPS or SSH address`);
  const outside = tmpdir();
  const user = await readConfig(outside);
  await git(outside, ["ls-remote", "--quiet", "--", url, "HEAD"], {
    timeoutMs: REACH_TIMEOUT_MS,
    network: { sshCommand: user.sshCommand },
  });
}
