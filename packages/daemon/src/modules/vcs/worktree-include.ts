import { constants } from "node:fs";
import { access, copyFile, lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type IncludedFiles, WORKTREE_INCLUDE_FILE } from "@trackwall/protocol";
import { messageOf } from "../../infra/errors.ts";
import { git } from "./git.ts";

/**
 * Files a new task worktree gets from the repo root (§4.4, ADR-61): the ones `WORKTREE_INCLUDE_FILE` in the root
 * names that git ignores, such as `.env` or a local Spring profile. A worktree is a checkout of committed files, so
 * without them a service that reads local config does not start there. Git picks the files: untracked files that match
 * the patterns of that file and that the ignore rules ignore both in the root and in the worktree (which has the base
 * commit's `.gitignore` and index, not the root's), so a file the worktree tracks is never overwritten and a copied
 * file never shows up as a change the agent could commit. Only regular files are copied, never over an existing file
 * and never through a linked directory: a link could point anywhere on the user's disk.
 */

/** A handful of config files; more means a pattern that matches a build or dependency directory. */
const MAX_FILES = 100;
const MAX_BYTES = 10 * 1024 * 1024;
/** Listing untracked files walks the working directory, `node_modules` included. */
const LIST_TIMEOUT_MS = 60_000;

type Matches = { kind: "ok"; paths: string[] } | { kind: "too_many"; count: number | null };

export async function copyIncludedFiles(repoDir: string, worktree: string): Promise<IncludedFiles> {
  const includeFile = join(repoDir, WORKTREE_INCLUDE_FILE);
  if (!(await exists(includeFile))) return { files: [], problems: [] };
  const matches = await ignoredMatches(repoDir, worktree, includeFile);
  if (matches.kind === "too_many") {
    const count = matches.count ?? "so many";
    return { files: [], problems: [`${WORKTREE_INCLUDE_FILE} matches ${count} files, more than ${MAX_FILES}; nothing was copied`] };
  }
  const included: IncludedFiles = { files: [], problems: [] };
  const worktreeDir = await realpath(worktree);
  let bytes = 0;
  for (const path of matches.paths) {
    try {
      const copied = await copyOne(repoDir, worktreeDir, path, MAX_BYTES - bytes);
      if (typeof copied === "string") included.problems.push(`${path}: ${copied}`);
      else {
        bytes += copied.bytes;
        included.files.push(path);
      }
    } catch (err) {
      included.problems.push(`${path}: ${messageOf(err)}`);
    }
  }
  return included;
}

/** Copies one file; the bytes copied, or why it was not. */
async function copyOne(repoDir: string, worktreeDir: string, path: string, budget: number): Promise<{ bytes: number } | string> {
  const parts = path.split("/");
  const info = await lstat(join(repoDir, ...parts));
  if (!info.isFile()) return "not a regular file (a link or a special file)";
  if (info.size > budget) return `the files together would be more than ${MAX_BYTES / 1024 / 1024} MB`;
  const target = join(worktreeDir, ...parts);
  await mkdir(dirname(target), { recursive: true });
  // A directory the worktree tracks as a link would take the file outside the worktree.
  if ((await realpath(dirname(target))) !== dirname(target)) return "its directory in the worktree is a link";
  await copyFile(join(repoDir, ...parts), target, constants.COPYFILE_EXCL);
  return { bytes: info.size };
}

/**
 * Untracked files of the root that match the include patterns and that both the root's and the worktree's ignore
 * rules ignore, sorted.
 */
async function ignoredMatches(repoDir: string, worktree: string, includeFile: string): Promise<Matches> {
  const listed = await git(repoDir, ["ls-files", "-z", "--others", "--ignored", `--exclude-from=${includeFile}`], {
    timeoutMs: LIST_TIMEOUT_MS,
  });
  // A truncated listing: a pattern such as `*` matches a whole build directory.
  if (listed.truncated) return { kind: "too_many", count: null };
  let paths = split(listed.stdout);
  for (const dir of [repoDir, worktree]) {
    if (paths.length === 0) break;
    // Exit code 1: none of them is ignored. A path the directory's index tracks is never ignored.
    const ignored = await git(dir, ["check-ignore", "-z", "--stdin"], { stdin: `${paths.join("\0")}\0`, okExitCodes: [0, 1] });
    if (ignored.truncated) return { kind: "too_many", count: null };
    paths = split(ignored.stdout);
  }
  if (paths.length > MAX_FILES) return { kind: "too_many", count: paths.length };
  return { kind: "ok", paths: paths.sort() };
}

function split(output: Buffer): string[] {
  return output
    .toString("utf8")
    .split("\0")
    .filter((path) => path !== "");
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}
