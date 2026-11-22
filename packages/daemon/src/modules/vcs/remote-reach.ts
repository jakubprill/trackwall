import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { git } from "./git.ts";
import { mainRemote, readConfig } from "./git-config.ts";
import { networkAddress } from "./remote.ts";

/**
 * Questions to a repo's server that never run in the repo (ADR-195, ADR-295): `git ls-remote` of the remote's address,
 * with the environment without prompts a sync's fetch has, so a missing SSH key, an unknown host key or a missing sign-in
 * fails at once instead of hanging. It runs on the address the repo's configuration resolves to, in a fresh empty folder
 * of the daemon's state folder, so only the user's and the system's configuration apply: the doctor asks whenever
 * Settings opens and the server check every 15 minutes, and a repo's own configuration, which a task's agent can write,
 * must not run a program then (`core.sshCommand`, a credential helper, `uploadpack`). That is also the sign-in the
 * questions are about. It reads only the remote's refs; nothing is written.
 *
 * Not the system temp folder: git reads a `.git` it finds right in the folder it runs in, and a sandboxed task may write
 * the temp folder, so it could plant one, with a configuration that runs its own program, between the folder's making
 * and git's start. The state folder is one a sandboxed task cannot write, as long as it lies outside what the sandbox
 * grants (§8).
 */

/** A remote that answers does so in a second or two, also over a VPN; the doctor's report waits for the slowest host. */
const REACH_TIMEOUT_MS = 8_000;

/** The main remote's HTTPS or SSH address as `host/path`; `null` for anything else (a local folder, `git://`). */
export async function networkRemote(dir: string): Promise<{ url: string; address: string } | null> {
  const remote = mainRemote(await readConfig(dir));
  const address = remote && networkAddress(remote.url);
  return remote && address !== undefined ? { url: remote.url, address } : null;
}

/**
 * Throws git's message when the remote at `url` (an HTTPS or SSH address) does not answer with the user's sign-in;
 * `questionsDir` holds the fresh folder the question runs in (`SERVER_QUESTIONS_DIR` of the state folder).
 */
export async function reachRemote(url: string, questionsDir: string): Promise<void> {
  await lsRemote(url, ["HEAD"], questionsDir);
}

/**
 * The commits the server at `url` (an HTTPS or SSH address) has under `refs`, full ref names such as `refs/heads/main`,
 * asked in one connection; a ref the server does not have is missing from the map. Throws git's message when the server
 * does not answer with the user's sign-in.
 */
export async function serverTips(url: string, refs: readonly string[], questionsDir: string): Promise<ReadonlyMap<string, string>> {
  const tips = new Map<string, string>();
  // git matches each ref against the end of every ref name, so `refs/x/refs/heads/main` would answer too.
  for (const line of (await lsRemote(url, refs, questionsDir)).split("\n")) {
    const [hash, name] = line.split("\t");
    if (hash && name !== undefined && refs.includes(name)) tips.set(name, hash);
  }
  return tips;
}

async function lsRemote(url: string, refs: readonly string[], questionsDir: string): Promise<string> {
  if (networkAddress(url) === undefined) throw new Error(`${url} is not an HTTPS or SSH address`);
  // A fresh empty folder, not `questionsDir` itself, so that no question finds what another left there.
  await mkdir(questionsDir, { recursive: true });
  const outside = await mkdtemp(join(questionsDir, "ls-remote-"));
  try {
    const user = await readConfig(outside);
    // `url` already went through `insteadOf`; git applies the user's rules to it once more, as it would to a rewritten fetch.
    const { stdout } = await git(outside, ["ls-remote", "--quiet", "--", url, ...refs], {
      timeoutMs: REACH_TIMEOUT_MS,
      network: { sshCommand: user.sshCommand },
    });
    return stdout.toString("utf8");
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
}
