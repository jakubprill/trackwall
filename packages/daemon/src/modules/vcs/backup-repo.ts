import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, symbolicRef } from "./git.ts";
import { mainRemote, readConfig } from "./git-config.ts";
import { remoteAddress } from "./remote.ts";

/**
 * A repo the daemon itself writes to (§4.13, ADR-86): the local config store. It commits only the paths it was given, so
 * files the user adds to the store by hand stay theirs to commit, and pushes the current branch to the main remote when
 * there is one. Commits and pushes run without hooks and without signing, as nobody is at a terminal to answer a prompt,
 * and under a fixed identity, because the daemon, not the user, made them.
 */

const IDENTITY = ["user.name=Trackwall", "user.email=trackwall@localhost"];
/** A push over a VPN or to a network share can take a while; longer is more likely a hanging connection. */
const PUSH_TIMEOUT_MS = 2 * 60_000;

/** Makes `dir` a git repo with the branch `main`, unless it already is one. */
export async function ensureBackupRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  if (existsSync(join(dir, ".git"))) return;
  await git(dir, ["init", "-q", "-b", "main"]);
}

/** Commits the changes of `paths` (relative to `dir`, with `/`); `false` when they have none. */
export async function commitBackups(dir: string, paths: readonly string[], message: string): Promise<boolean> {
  const pathspecs = paths.map((path) => `:(literal)${path}`);
  await git(dir, ["add", "--", ...pathspecs]);
  // Against HEAD, and in a store without commits yet against the empty tree.
  const staged = await git(dir, ["diff", "--cached", "--name-only", "-z", "--", ...pathspecs]);
  if (staged.stdout.length === 0) return false;
  await withoutHooks((noHooks) =>
    git(dir, ["commit", "-q", "--no-verify", "-m", message, "--", ...pathspecs], {
      config: [...IDENTITY, `core.hooksPath=${noHooks}`, "commit.gpgSign=false"],
    }),
  );
  return true;
}

/**
 * The main remote as shown to the user: `host/path` for a repo host, the path itself for a local or shared folder, and
 * only the remote's name for anything else, which could carry a command. `null` without a main remote.
 */
export async function backupRemote(dir: string): Promise<string | null> {
  if (!existsSync(join(dir, ".git"))) return null;
  const remote = mainRemote(await readConfig(dir));
  if (!remote) return null;
  if (remote.url.includes("::")) return remote.name;
  return remoteAddress(remote.url) ?? remote.url;
}

/**
 * Pushes the current branch to the branch of the same name on the main remote, never forced: a remote another computer
 * pushed to first refuses it, and the user merges in the store by hand. `false` without a main remote.
 */
export async function pushBackups(dir: string): Promise<boolean> {
  const config = await readConfig(dir);
  const remote = mainRemote(config);
  if (!remote) return false;
  const ref = await symbolicRef(dir, "HEAD");
  if (ref === undefined) throw new Error(`${dir} has no current branch to push`);
  await withoutHooks((noHooks) =>
    git(dir, ["push", "--no-follow-tags", "--no-recurse-submodules", "--", remote.name, `${ref}:${ref}`], {
      timeoutMs: PUSH_TIMEOUT_MS,
      network: { sshCommand: config.sshCommand },
      config: [`core.hooksPath=${noHooks}`, "push.gpgSign=false"],
    }),
  );
  return true;
}

/** An empty hooks directory for one command: `--no-verify` skips only some hooks, `core.hooksPath` all of them. */
async function withoutHooks<T>(run: (noHooks: string) => Promise<T>): Promise<T> {
  const noHooks = mkdtempSync(join(tmpdir(), "trackwall-no-hooks-"));
  try {
    return await run(noHooks);
  } finally {
    rmSync(noHooks, { recursive: true, force: true });
  }
}
