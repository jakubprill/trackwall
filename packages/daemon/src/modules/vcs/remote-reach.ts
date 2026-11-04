import { git } from "./git.ts";
import { mainRemote, readConfig } from "./git-config.ts";
import { networkAddress } from "./remote.ts";

/**
 * Whether git reaches a repo's main remote as a sync's fetch would (ADR-195): `git ls-remote` of the same remote, with the
 * same environment without prompts, so a missing SSH key, an unknown host key or a missing sign-in fails here at once
 * instead of hanging. It reads only the remote's refs; nothing is fetched or written.
 */

/** A remote that answers does so in a second or two, also over a VPN; longer is a host that cannot be reached. */
const REACH_TIMEOUT_MS = 15_000;

/** The remote it reached as `host/path`; `null` for a repo whose main remote is no HTTPS or SSH address (nothing to check). */
export async function reachRemote(dir: string): Promise<string | null> {
  const config = await readConfig(dir);
  const remote = mainRemote(config);
  const address = remote && networkAddress(remote.url);
  if (!remote || address === undefined) return null;
  await git(dir, ["ls-remote", "--quiet", "--", remote.name, "HEAD"], {
    timeoutMs: REACH_TIMEOUT_MS,
    network: { sshCommand: config.sshCommand },
  });
  return address;
}
