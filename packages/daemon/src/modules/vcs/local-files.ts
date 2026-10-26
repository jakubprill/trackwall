import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { git } from "./git.ts";
import { gitDirs, readIfExists } from "./git-dir.ts";
import { checkIgnore } from "./worktree-include.ts";

/**
 * Files a repo keeps outside git on purpose (§4.13, ADR-86): which of them git tracks or ignores, and ignoring them in
 * this clone only, through `info/exclude` of the git directory the repo shares with its worktrees, so that a task
 * worktree ignores them too and nothing is pushed.
 */

/** The paths of `paths` (relative to the repo root, with `/`) that the repo's index tracks. */
export async function trackedPaths(dir: string, paths: readonly string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  const { stdout } = await git(dir, ["ls-files", "-z", "--", ...paths.map(literal)]);
  return new Set(
    stdout
      .toString("utf8")
      .split("\0")
      .filter((path) => path !== ""),
  );
}

/** The paths of `paths` that the repo's ignore rules ignore; a tracked path is never ignored. */
export async function ignoredPaths(dir: string, paths: readonly string[]): Promise<Set<string>> {
  return new Set(await checkIgnore(dir, paths));
}

/**
 * Adds an anchored pattern for each of `paths` to `info/exclude`, unless the file already has that line. The patterns are
 * appended, never rewritten, so the user's own lines stay as they were.
 */
export async function excludeLocally(dir: string, paths: readonly string[]): Promise<void> {
  const dirs = await gitDirs(dir);
  if (!dirs) throw new Error(`${dir} has no git directory`);
  const info = join(dirs.commonDir, "info");
  const exclude = join(info, "exclude");
  const text = await readIfExists(exclude);
  const lines = new Set(text.split(/\r?\n/).map((line) => line.trim()));
  const missing = paths.map((path) => `/${path}`).filter((pattern) => !lines.has(pattern));
  if (missing.length === 0) return;
  await mkdir(info, { recursive: true });
  const separator = text === "" || text.endsWith("\n") ? "" : "\n";
  await appendFile(exclude, `${separator}${missing.join("\n")}\n`);
}

/** A path as a pathspec without wildcards, so a name with `*` or `[` means only itself. */
function literal(path: string): string {
  return `:(literal)${path}`;
}
