import type { Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Reading a repo's git directory without a `git` process (§4.5): where its files are, and the reads the repo watch
 * (`git-state.ts`), the HEAD commit (`head-commit.ts`) and the configuration memo (`config-memo.ts`) share. A missing file
 * is an answer; any other error (a sharing violation while git renames over the file, an antivirus, a network timeout)
 * throws, so the caller can tell "not there" from "not readable this time".
 */

/**
 * The git directory of the repo (with `HEAD`) and the common one (with `refs/` and `packed-refs`): both `.git` in a normal
 * clone; in a worktree `.git` is a file with `gitdir: <path>`, and that directory names the common one in `commondir`.
 */
export async function gitDirs(repo: string): Promise<{ gitDir: string; commonDir: string } | null> {
  const dotGit = join(repo, ".git");
  const info = await statIfExists(dotGit);
  if (!info) return null;
  if (info.isDirectory()) return { gitDir: dotGit, commonDir: dotGit };
  const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(dotGit, "utf8"));
  if (!pointer?.[1]) return null;
  const gitDir = relativeTo(repo, pointer[1]);
  const common = (await readIfExists(join(gitDir, "commondir"))).trim();
  return { gitDir, commonDir: common ? relativeTo(gitDir, common) : gitDir };
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

/** Size and file identity next to the time: a rename over the file gives a new identity even within one timestamp tick. */
export function fileKey(info: Stats): string {
  return `${info.mtimeMs}:${info.size}:${info.ino}`;
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
