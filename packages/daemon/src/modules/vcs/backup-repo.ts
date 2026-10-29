import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
 * address, since hooks on the receiving side are beyond this side's reach, and only to the address the user allowed,
 * from a repo outside the store (ADR-127), since `git remote add` keys are allowed here and an agent can write them too.
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
 * The store's main remote as the user may allow it (ADR-127): its address as the store's config writes it, and why it
 * cannot be allowed, if it cannot. `null` without a main remote.
 */
export interface BackupRemote {
  url: string;
  problem: string | null;
}

export async function backupRemote(dir: string): Promise<BackupRemote | null> {
  if (!(await isRealGitDir(dir))) return null;
  const config = await readConfig(dir);
  const remote = mainRemote(config);
  if (!remote) return null;
  const urls = config.remotes.get(remote.name) ?? [];
  const url = urls[0] ?? remote.url;
  // git pushes to every address of a remote, so a user allowing what they see would allow more than they see.
  if (urls.length !== 1) return { url, problem: `${remote.name} has ${urls.length} addresses; Trackwall pushes the store only to one` };
  return { url, problem: pushAddressProblem(url) };
}

/**
 * Why the store cannot be pushed to `url`, or `null`. Only to an HTTPS or SSH address: a local path or a shared folder is
 * a repo an agent may have written, and its `pre-receive` hook would run as the user, out of reach of `core.hooksPath`
 * here. The user allows the address as they read it, so it must name the host git connects to plainly: only printable
 * ASCII without a space or backslash (a URL parser takes `\` for `/`, curl does not; a Cyrillic letter looks like a Latin
 * one), and an SSH user without `.` or `:`, so `ssh://github.com@other.example/x` cannot pass for `github.com`, and no `@`
 * after the host of `host:path`, so `other.example:x@github.com:me/x` cannot either.
 */
function pushAddressProblem(url: string): string | null {
  if ([...url].some((c) => c === "\\" || c.charCodeAt(0) <= 0x20 || c.charCodeAt(0) >= 0x7f))
    return "The store's remote has a space, a backslash or a character outside ASCII; Trackwall does not push to such an address";
  if (misleadingSshAddress(url))
    return "The store's remote has a user or path that looks like a host; Trackwall does not push to such an address";
  if (networkAddress(url) === undefined)
    return "The store's remote is not an HTTPS or SSH address of a repo host; Trackwall pushes the store only to one";
  return null;
}

/** `ssh://user@host/path` or `user@host:path` whose user or path could be read as the host. */
function misleadingSshAddress(url: string): boolean {
  const ssh = /^ssh:\/\/([^/]*)@[^/@]*\//i.exec(url);
  if (ssh) return /[.:@]/.test(ssh[1] ?? "");
  if (url.includes("://")) return false;
  const colon = url.indexOf(":");
  const user = url.slice(0, colon).split("@").slice(0, -1).join("@");
  return /[.:@]/.test(user) || url.slice(colon + 1).includes("@");
}

/**
 * Pushes `commit` of the store to `main` at `url`, the address the user allowed (ADR-127), never forced: a remote another
 * computer pushed to first refuses it. The push runs in `pushDir`, a repo in the state folder whose config only the
 * daemon writes, which reads the store's objects through `objects/info/alternates`: the store's own config, which an
 * agent can rewrite at any moment, plays no part, so no `pushurl`, second address, `sshCommand` or credential helper
 * written there between a check and the push can redirect it or run a program.
 */
export async function pushBackups(store: string, pushDir: string, url: string, commit: string): Promise<void> {
  const problem = pushAddressProblem(url);
  if (problem !== null) throw new Error(problem);
  await ensurePushRepo(pushDir, store);
  const config = await readConfig(pushDir);
  await withoutHooks((hooksPath) =>
    git(
      pushDir,
      ["push", "--no-follow-tags", "--no-recurse-submodules", "--receive-pack=git-receive-pack", "--", url, `${commit}:${BRANCH}`],
      {
        timeoutMs: PUSH_TIMEOUT_MS,
        network: { sshCommand: config.sshCommand },
        config: [hooksPath, "push.gpgSign=false"],
      },
    ),
  );
}

/**
 * `pushDir` as a repo that borrows the store's objects; the store's folder can change with the projects folder. Not bare,
 * since git refuses to find a bare repo under `safe.bareRepository=explicit`, which a careful user may set.
 */
async function ensurePushRepo(pushDir: string, store: string): Promise<void> {
  await mkdir(pushDir, { recursive: true });
  if (!(await lstat(pushDir)).isDirectory()) throw new Error(`${pushDir} is not a folder (a link?)`);
  if (!existsSync(join(pushDir, ".git", "HEAD"))) await git(pushDir, ["init", "-q"]);
  // Forward slashes, which git reads on every system.
  await writeFile(join(pushDir, ".git", "objects", "info", "alternates"), `${join(store, ".git", "objects").replaceAll("\\", "/")}\n`);
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
