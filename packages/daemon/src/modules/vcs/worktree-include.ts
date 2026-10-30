import { constants, existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type IncludedFiles, noIncludedFiles, WORKTREE_INCLUDE_FILE } from "@trackwall/protocol";
import { messageOf } from "../../infra/errors.ts";
import { git } from "./git.ts";

/**
 * Files a new task worktree gets from the repo root (§4.4, ADR-61): the ones `WORKTREE_INCLUDE_FILE` in the root
 * names that git ignores, such as `.env` or a local Spring profile. A worktree is a checkout of committed files, so
 * without them a service that reads local config does not start there. Git picks the files: untracked files that match
 * the patterns of that file and that the ignore rules ignore both in the root and in the worktree (which has the base
 * commit's `.gitignore` and index, not the root's), so a file the worktree tracks is never overwritten and a copied
 * file never shows up as a change the agent could commit. Only regular files are copied, never over an existing file
 * and never through a linked directory: a link could point anywhere on the user's disk. Every file left out gets a
 * problem, so the user knows what the worktree lacks. Copying again into a task's existing worktree (a line added to
 * that file later) works the same: a file the worktree already has with the root's content counts as copied, and one
 * with other content stays as it is, since the agent or the user may have changed it there.
 */

/** A handful of config files; more means a pattern that matches a build or dependency directory. */
const MAX_FILES = 100;
const MAX_BYTES = 10 * 1024 * 1024;
/** Listing untracked files walks the working directory, `node_modules` included. */
const LIST_TIMEOUT_MS = 60_000;
/** Git's refusal to check a path whose directory is a link in the worktree (`pathspec '…' is beyond a symbolic link`). */
const BEYOND_LINK = "beyond a symbolic link";

type Matches = { kind: "ok"; paths: string[]; leftOut: string[] } | { kind: "too_many"; count: number | null };

export async function copyIncludedFiles(repoDir: string, worktree: string): Promise<IncludedFiles> {
  const includeFile = join(repoDir, WORKTREE_INCLUDE_FILE);
  if (!existsSync(includeFile)) return noIncludedFiles();
  const matches = await ignoredMatches(repoDir, worktree, includeFile);
  if (matches.kind === "too_many") {
    const count = matches.count ?? "so many";
    return { files: [], problems: [`${WORKTREE_INCLUDE_FILE} matches ${count} files, more than ${MAX_FILES}; nothing was copied`] };
  }
  const included: IncludedFiles = {
    files: [],
    problems: matches.leftOut,
  };
  let bytes = 0;
  for (const path of matches.paths) {
    try {
      const copied = await copyOne(repoDir, worktree, path, MAX_BYTES - bytes);
      if (typeof copied === "string") included.problems.push(`${path}: ${copied}`);
      else {
        bytes += copied.bytes;
        included.files.push(path);
      }
    } catch (err) {
      included.problems.push(`${path}: ${messageOf(err)}`);
    }
  }
  included.problems.sort();
  return included;
}

/** Copies one file; the bytes copied, or why it was not. */
async function copyOne(repoDir: string, worktree: string, path: string, budget: number): Promise<{ bytes: number } | string> {
  const parts = path.split("/");
  const info = await lstat(join(repoDir, ...parts));
  if (!info.isFile()) return "not a regular file (a link or a special file)";
  if (info.size > budget) return `the files together would be more than ${MAX_BYTES / 1024 / 1024} MB`;
  if (!(await realDirectories(worktree, parts.slice(0, -1)))) return "its directory in the worktree is a link or a file";
  const existing = await sameAsInWorktree(repoDir, worktree, parts);
  if (existing === "same") return { bytes: 0 };
  if (existing === "other") return "the worktree has its own version of it, left as it is";
  await copyFile(join(repoDir, ...parts), join(worktree, ...parts), constants.COPYFILE_EXCL);
  return { bytes: info.size };
}

/** Whether the worktree already has the file: with the root's content, with other content (or not as a regular file), or not at all. */
async function sameAsInWorktree(repoDir: string, worktree: string, parts: readonly string[]): Promise<"same" | "other" | "none"> {
  const target = join(worktree, ...parts);
  const info = await lstat(target).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (info === null) return "none";
  if (!info.isFile()) return "other";
  const [inRoot, inWorktree] = await Promise.all([readFile(join(repoDir, ...parts)), readFile(target)]);
  return inRoot.equals(inWorktree) ? "same" : "other";
}

/**
 * Makes the directories of `dirs` under `worktree` one at a time; `false` when one of them is a link (also a Windows
 * junction), before anything is created through it.
 */
async function realDirectories(worktree: string, dirs: readonly string[]): Promise<boolean> {
  let dir = worktree;
  for (const name of dirs) {
    dir = join(dir, name);
    const info = await lstat(dir).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    if (info === null) await mkdir(dir);
    else if (!info.isDirectory()) return false;
  }
  return true;
}

/**
 * Untracked files of the root that match the include patterns and that the root's ignore rules ignore, sorted, split
 * into the ones the worktree's ignore rules ignore too and the ones they do not.
 */
async function ignoredMatches(repoDir: string, worktree: string, includeFile: string): Promise<Matches> {
  const listed = await git(repoDir, ["ls-files", "-z", "--others", "--ignored", `--exclude-from=${includeFile}`], {
    timeoutMs: LIST_TIMEOUT_MS,
  });
  const matches = split(listed.stdout);
  // A pattern such as `*` that matches a whole build directory: not worth checking path by path.
  if (listed.truncated) return { kind: "too_many", count: null };
  const ignored = await checkIgnore(repoDir, matches);
  if (ignored.length > MAX_FILES) return { kind: "too_many", count: ignored.length };
  const inWorktree = await checkIgnore(worktree, ignored).catch((err: unknown) => {
    if (messageOf(err).includes(BEYOND_LINK)) return null;
    throw err;
  });
  if (inWorktree === null) return eachInWorktree(worktree, ignored);
  const kept = new Set(inWorktree);
  return {
    kind: "ok",
    paths: ignored.filter((p) => kept.has(p)).sort(),
    leftOut: ignored.filter((p) => !kept.has(p)).map(notIgnoredInWorktree),
  };
}

/**
 * Git refuses the whole check for one path it cannot check in the worktree (`beyond a symbolic link`: the base commit
 * has a directory of it as a link), so the paths are checked one by one and such a path is left out with git's reason.
 */
async function eachInWorktree(worktree: string, ignored: readonly string[]): Promise<Matches> {
  const paths: string[] = [];
  const leftOut: string[] = [];
  for (const path of ignored) {
    const checked = await checkIgnore(worktree, [path]).catch((err: unknown) => {
      if (messageOf(err).includes(BEYOND_LINK)) return messageOf(err);
      throw err;
    });
    if (typeof checked === "string") leftOut.push(`${path}: ${checked}`);
    else if (checked.length > 0) paths.push(path);
    else leftOut.push(notIgnoredInWorktree(path));
  }
  return { kind: "ok", paths: paths.sort(), leftOut };
}

function notIgnoredInWorktree(path: string): string {
  return `${path}: the task's base commit tracks it or does not ignore it`;
}

/** The paths the ignore rules of `dir` ignore; a path its index tracks is never ignored. */
export async function checkIgnore(dir: string, paths: readonly string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  // Exit code 1: none of them is ignored.
  const ignored = await git(dir, ["check-ignore", "-z", "--stdin"], { stdin: `${paths.join("\0")}\0`, okExitCodes: [0, 1] });
  if (ignored.truncated) throw new Error(`git check-ignore listed more than it can return for ${paths.length} files`);
  return split(ignored.stdout);
}

function split(output: Buffer): string[] {
  return output
    .toString("utf8")
    .split("\0")
    .filter((path) => path !== "");
}
