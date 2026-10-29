import { lstat, mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { removeFolder, removeIfPresent } from "../../infra/remove-folder.ts";
import { existingCommit, git, symbolicRef } from "./git.ts";
import { mainRemote, readConfig } from "./git-config.ts";
import { readBranchCommit } from "./head-commit.ts";
import { withoutHooks } from "./no-hooks.ts";
import { networkAddress } from "./remote.ts";

/**
 * A repo the daemon itself writes to (§4.13, ADR-86): the local config store. An agent can write into its folder like
 * into any other, so nothing in it is trusted. The folder and its `.git` must be real directories, never a link or a
 * `gitdir:` file that would point at another repo, and its own `.git/config` may hold only the keys `git init`, `git
 * clone` and `git remote add` write (`STORE_CONFIG`): any other key could make git run a program (a filter, a
 * `receivepack`, an `sshCommand`) or push elsewhere (`pushurl`, `pushInsteadOf`). Commits are built from the content the
 * daemon read, with plumbing and a temporary index (`hash-object --no-filters`, `commit-tree`, `update-ref`), so no
 * filter, attribute or hook runs and the user's own index keeps what they staged; only the backed-up paths are then
 * updated in the index, so `git status` in the store stays clean. Every git command that writes runs without hooks and
 * signing, under a fixed identity, because the daemon, not the user, made it, and the push goes only to an HTTPS or SSH
 * address, since hooks on the receiving side are beyond this side's reach.
 */

const IDENTITY = ["user.name=Trackwall", "user.email=trackwall@localhost", "commit.gpgSign=false"];
/** A push over a VPN or to a network share can take a while; longer is more likely a hanging connection. */
const PUSH_TIMEOUT_MS = 2 * 60_000;
const BRANCH = "refs/heads/main";
/** The store's `.git/config` keys git itself writes; `<name>` parts are any subsection. */
const STORE_CONFIG = [
  /^core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks)$/,
  /^extensions\.objectformat$/,
  /^remote\..+\.(url|fetch)$/s,
  /^branch\..+\.(remote|merge)$/s,
];

/** A file to back up: its path in the store, with `/`, and its content. */
export interface BackupFile {
  path: string;
  content: Buffer;
}

/**
 * Makes `dir` the store, a git repo on `main`, unless it already is one, and checks it as described above; an error says
 * what to fix.
 */
export async function ensureBackupRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  if (!(await lstat(dir)).isDirectory())
    throw new Error(`${dir} is not a folder (a link?); Trackwall keeps local config only in a real one`);
  const dotGit = await lstat(join(dir, ".git")).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return undefined;
    throw err;
  });
  if (!dotGit) {
    await git(dir, ["init", "-q"]);
    await git(dir, ["symbolic-ref", "HEAD", BRANCH]);
  } else if (!dotGit.isDirectory())
    throw new Error(`${join(dir, ".git")} is not a folder; Trackwall commits only into the store's own repo`);
  const { stdout } = await git(dir, ["config", "--local", "-z", "--list"]);
  const unknown = stdout
    .toString("utf8")
    .split("\0")
    .map((entry) => entry.split("\n", 1)[0] ?? "")
    .find((key) => key !== "" && !STORE_CONFIG.some((allowed) => allowed.test(key)));
  if (unknown !== undefined)
    throw new Error(`the store's .git/config sets ${unknown}, which Trackwall does not run git with; remove it (git config --unset)`);
  if ((await symbolicRef(dir, "HEAD")) !== BRANCH) throw new Error(`the store is not on ${BRANCH}; Trackwall backs up only to that branch`);
}

/**
 * Commits `files` on top of `main`; `false` when the tree stays the same. Call after `ensureBackupRepo`, and one at a
 * time. The user's index is updated after the commit, only for the backed-up paths; when that fails the commit stands.
 */
export async function commitBackups(dir: string, files: readonly BackupFile[], message: string, scratchDir: string): Promise<boolean> {
  // Even `read-tree` and `update-index` run a hook (`post-index-change`), so no command here may see the store's hooks.
  return withoutHooks(async (hooksPath) => {
    const config = [hooksPath];
    const parent = (await existingCommit(dir, BRANCH)) ?? null;
    const scratch = await mkdtemp(join(scratchDir, "store-index-"));
    const indexFile = join(scratch, "index");
    let entries: { path: string; oid: string }[];
    try {
      if (parent !== null) await git(dir, ["read-tree", parent], { indexFile, config });
      entries = await Promise.all(files.map(async (f) => ({ path: f.path, oid: await hashBlob(dir, f.content, config) })));
      for (const { path, oid } of entries) await git(dir, updateIndex(path, oid), { indexFile, config });
      const tree = (await git(dir, ["write-tree"], { indexFile, config })).stdout.toString("utf8").trim();
      if (parent !== null && tree === (await treeOf(dir, parent))) return false;
      const parents = parent === null ? [] : ["-p", parent];
      const made = (await git(dir, ["commit-tree", tree, ...parents, "-m", message], { config: [...IDENTITY, hooksPath] })).stdout;
      // The old value guards against a commit someone else made meanwhile; an empty one means the branch must not exist yet.
      await git(dir, ["update-ref", "-m", message, BRANCH, made.toString("utf8").trim(), parent ?? ""], { config });
    } finally {
      // A leftover index in the scratch folder harms nothing, so failing to remove it does not fail a backup that worked.
      await removeFolder(scratch, removeIfPresent).catch(() => undefined);
    }
    for (const { path, oid } of entries) await git(dir, updateIndex(path, oid), { config });
    return true;
  });
}

/** The commit of `main`, read from the git directory's files where they tell for sure (a pass reads it every few seconds); `null` before the first backup. */
export async function storeHead(dir: string): Promise<string | null> {
  if (!(await isRealGitDir(dir))) return null;
  const fromFiles = await readBranchCommit(dir, BRANCH).catch(() => undefined);
  return fromFiles !== undefined ? fromFiles : ((await existingCommit(dir, BRANCH)) ?? null);
}

/**
 * The main remote as shown to the user: `host/path` for an HTTPS or SSH address, otherwise only the remote's name, which
 * the backups are never pushed to (`pushBackups`). `null` without a main remote.
 */
export async function backupRemote(dir: string): Promise<string | null> {
  if (!(await isRealGitDir(dir))) return null;
  const remote = mainRemote(await readConfig(dir));
  if (!remote) return null;
  return networkAddress(remote.url) ?? remote.name;
}

/**
 * Pushes `main` to the main remote, never forced: a remote another computer pushed to first refuses it. `false` without
 * a main remote. Only to an HTTPS or SSH address: a local path or a shared folder is a repo an agent may have written,
 * and its `pre-receive` hook would run as the user, out of reach of `core.hooksPath` here. Call after `ensureBackupRepo`,
 * which keeps `pushurl` and other redirections out of the store's config.
 */
export async function pushBackups(dir: string): Promise<boolean> {
  const config = await readConfig(dir);
  const remote = mainRemote(config);
  if (!remote) return false;
  if (networkAddress(remote.url) === undefined)
    throw new Error(`${remote.name} is not an HTTPS or SSH address of a repo host; Trackwall pushes the store only to one`);
  await withoutHooks((hooksPath) =>
    git(dir, ["push", "--no-follow-tags", "--no-recurse-submodules", "--", remote.name, `${BRANCH}:${BRANCH}`], {
      timeoutMs: PUSH_TIMEOUT_MS,
      network: { sshCommand: config.sshCommand },
      config: [hooksPath, `remote.${remote.name}.receivepack=git-receive-pack`, "push.gpgSign=false"],
    }),
  );
  return true;
}

function updateIndex(path: string, oid: string): string[] {
  return ["update-index", "--add", "--cacheinfo", `100644,${oid},${path}`];
}

async function hashBlob(dir: string, content: Buffer, config: string[]): Promise<string> {
  return (await git(dir, ["hash-object", "-w", "--no-filters", "--stdin"], { stdin: content, config })).stdout.toString("utf8").trim();
}

async function treeOf(dir: string, commit: string): Promise<string> {
  return (await git(dir, ["rev-parse", `${commit}^{tree}`])).stdout.toString("utf8").trim();
}

/** Whether `dir` has a `.git` directory of its own, not a link or a `gitdir:` file. */
async function isRealGitDir(dir: string): Promise<boolean> {
  return (await lstat(join(dir, ".git")).catch(() => undefined))?.isDirectory() === true;
}
