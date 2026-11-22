import type { Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileKey } from "../../infra/file-key.ts";

/**
 * Reading a repo's git directory without a `git` process (§4.5): where its files are, and the reads the repo watch
 * (`git-state.ts`), the HEAD commit (`head-commit.ts`) and the configuration memo (`config-memo.ts`) share. A missing file
 * is an answer; any other error (a sharing violation while git renames over the file, an antivirus, a network timeout)
 * throws, so the caller can tell "not there" from "not readable this time".
 */

export interface GitDirs {
  gitDir: string;
  commonDir: string;
}

/**
 * The git directory of the repo (with `HEAD`) and the common one (with `refs/` and `packed-refs`): both `.git` in a normal
 * clone; in a worktree `.git` is a file with `gitdir: <path>`, and that directory names the common one in `commondir`.
 * Git reads `commondir` in any git directory, a clone's own `.git` too, so it is read there as well: whoever writes
 * that file moves git to another configuration (`run-settings.ts`).
 */
export async function gitDirs(repo: string): Promise<GitDirs | null> {
  const dotGit = join(repo, ".git");
  const info = await statIfExists(dotGit);
  if (!info) return null;
  const gitDir = info.isDirectory() ? dotGit : await pointedGitDir(repo, dotGit);
  if (gitDir === null) return null;
  const common = (await readIfExists(join(gitDir, "commondir"))).trim();
  return { gitDir, commonDir: common ? relativeTo(gitDir, common) : gitDir };
}

/** The git directory a worktree's `.git` file names; `null` for a file that names none. */
async function pointedGitDir(repo: string, dotGit: string): Promise<string | null> {
  const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(dotGit, "utf8"));
  return pointer?.[1] ? relativeTo(repo, pointer[1]) : null;
}

/**
 * `refs/…` from the text of `HEAD` (`ref: refs/heads/main`); `undefined` for a detached HEAD or a ref that could lead out of
 * the git directory: `HEAD` comes from the repo, and `\\` is a separator on Windows.
 */
export function headRefName(text: string): string | undefined {
  const ref = /^ref:\s*(refs\/\S+)$/.exec(text.trim())?.[1];
  return ref && !ref.includes("\\") && !ref.split("/").includes("..") ? ref : undefined;
}

/** The file every `git fetch` and `git pull` rewrites, also when nothing came; git keeps one per worktree. */
export function fetchHeadFile(dirs: GitDirs): string {
  return join(dirs.gitDir, "FETCH_HEAD");
}

/**
 * When the repo last fetched from a remote (ADR-291): the modification time of its `FETCH_HEAD`; `null` when it never
 * fetched (a fresh clone has no such file) or has no git directory.
 */
export async function lastFetch(repo: string): Promise<string | null> {
  const dirs = await gitDirs(repo);
  const info = dirs && (await statIfExists(fetchHeadFile(dirs)));
  return info ? info.mtime.toISOString() : null;
}

/** `undefined` for a file that is not there. */
export async function statIfExists(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
  } catch (err) {
    if (isMissing(err)) return undefined;
    throw err;
  }
}

/** The empty text for a file that is not there. */
export async function readIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (isMissing(err)) return "";
    throw err;
  }
}

export function optionalKey(info: Stats | undefined): string {
  return info ? fileKey(info) : "-";
}

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function relativeTo(base: string, path: string): string {
  return isAbsolute(path) ? path : resolve(base, path);
}
