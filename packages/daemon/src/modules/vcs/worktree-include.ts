import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { WORKTREE_INCLUDE_FILE } from "@trackwall/protocol";
import { git } from "./git.ts";

/**
 * Files a new task worktree gets from the repo root (§4.4, ADR-61): the ones `WORKTREE_INCLUDE_FILE` in the root
 * names that git ignores, such as `.env` or a local Spring profile. A worktree is a checkout of committed files, so
 * without them a service that reads local config does not start there. Git picks the files: untracked files that match
 * the patterns of that file and that the repo's own ignore rules ignore, so a tracked file is never overwritten and an
 * untracked file nobody meant to keep out of git is never copied. Only regular files are copied: a link could point
 * anywhere on the user's disk.
 */

/** A handful of config files; more means a pattern that matches a build or dependency directory. */
const MAX_FILES = 100;
const MAX_BYTES = 10 * 1024 * 1024;
/** Listing untracked files walks the working directory, `node_modules` included. */
const LIST_TIMEOUT_MS = 60_000;

export interface IncludedFiles {
  /** Copied paths relative to the root, with `/`. */
  files: string[];
  /** What was not copied and why, one sentence each. */
  problems: string[];
}

export async function copyIncludedFiles(repoDir: string, worktree: string): Promise<IncludedFiles> {
  const includeFile = join(repoDir, WORKTREE_INCLUDE_FILE);
  if (!existsSync(includeFile)) return { files: [], problems: [] };
  const included: IncludedFiles = { files: [], problems: [] };
  const candidates = await ignoredMatches(repoDir, includeFile);
  if (candidates === "too_many" || candidates.length > MAX_FILES) {
    const count = candidates === "too_many" ? "so many" : candidates.length;
    return { files: [], problems: [`${WORKTREE_INCLUDE_FILE} matches ${count} files, more than ${MAX_FILES}; nothing was copied`] };
  }
  let bytes = 0;
  for (const path of candidates) {
    const source = join(repoDir, ...path.split("/"));
    const info = await lstat(source);
    if (!info.isFile()) {
      included.problems.push(`${path} is not a regular file (a link or a special file)`);
      continue;
    }
    bytes += info.size;
    if (bytes > MAX_BYTES) {
      included.problems.push(`${path} and the files after it: more than ${MAX_BYTES / 1024 / 1024} MB together`);
      break;
    }
    const target = join(worktree, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    included.files.push(path);
  }
  return included;
}

/**
 * Untracked files that match the include patterns and that the repo's ignore rules ignore, sorted; `too_many` when
 * the listing outgrew the output limit (a pattern such as `*` matches the whole build directory).
 */
async function ignoredMatches(repoDir: string, includeFile: string): Promise<string[] | "too_many"> {
  const listed = await git(repoDir, ["ls-files", "-z", "--others", "--ignored", `--exclude-from=${includeFile}`], {
    timeoutMs: LIST_TIMEOUT_MS,
  });
  if (listed.truncated) return "too_many";
  const matches = split(listed.stdout);
  if (matches.length > MAX_FILES) return matches;
  if (matches.length === 0) return [];
  // Exit code 1: none of them is ignored.
  const ignored = await git(repoDir, ["check-ignore", "-z", "--stdin"], { stdin: `${matches.join("\0")}\0`, okExitCodes: [0, 1] });
  return split(ignored.stdout).sort();
}

function split(output: Buffer): string[] {
  return output
    .toString("utf8")
    .split("\0")
    .filter((path) => path !== "");
}
