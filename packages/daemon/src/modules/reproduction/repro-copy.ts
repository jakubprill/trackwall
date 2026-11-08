import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, realpath, rm, utimes } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { isInside } from "../../infra/path-inside.ts";

/**
 * What a reproduction check copies from a task's worktree into its own copy of the repo (ADR-227): first the task's test
 * side onto the base commit, then the rest of the task's changes. The paths come from git (the task's changed files
 * against its base), never from the agent's report; a changed path is copied as a regular file, deleted when the task
 * deleted it, and refused when it is a link or a folder (a nested repo) or when either side is reached through a linked
 * folder. A copied file gets the time of the copy, so a build tool that compares times (Maven's compiler) never takes
 * it for older than what the run on the base compiled.
 */

/** Test files by the Maven and Gradle layout: anything under a `src/test/` folder, in any module. */
const TEST_SOURCES = /(?:^|\/)src\/test\//;

/** A path as git lists it: `/` between names, without `./` or a doubled `/`. */
export function gitPath(path: string): string {
  return posix.normalize(path.replaceAll("\\", "/"));
}

/**
 * The changed paths that go onto the base: the test sources, the reproduction test's own file and the files of the mise
 * config the user trusted for the task's worktree, so the copy's mise config is that one in both runs.
 */
export function testSide(
  paths: readonly string[],
  testFile: string,
  miseConfigPaths: readonly string[],
): { tests: string[]; rest: string[] } {
  const own = gitPath(testFile);
  const mise = new Set(miseConfigPaths);
  const tests = paths.filter((path) => path === own || TEST_SOURCES.test(path) || mise.has(path));
  return { tests, rest: paths.filter((path) => !tests.includes(path)) };
}

/** Copies each path from `worktree` into `copy` as it is there now; throws, naming the path, on anything but a file. */
export async function copyChanged(worktree: string, copy: string, paths: readonly string[]): Promise<void> {
  const roots = { from: await realpath(worktree), to: await realpath(copy) };
  for (const path of paths) await copyOne(roots, path);
}

async function copyOne(roots: { from: string; to: string }, path: string): Promise<void> {
  const from = join(roots.from, ...path.split("/"));
  const to = join(roots.to, ...path.split("/"));
  await assertNotLinked(roots.from, dirname(from), path);
  await assertNotLinked(roots.to, dirname(to), path);
  const info = await lstat(from).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return undefined;
    throw err;
  });
  if (info === undefined) {
    await rm(to, { force: true });
    return;
  }
  if (!info.isFile())
    throw new Error(`${path} is a ${info.isSymbolicLink() ? "link" : "folder"} in the task's worktree, which a check does not copy`);
  await mkdir(dirname(to), { recursive: true });
  // The base commit may have a link there, which copying onto would follow.
  await rm(to, { force: true });
  await copyFile(from, to);
  const now = new Date();
  await utimes(to, now, now);
}

/**
 * The folder, or its nearest existing ancestor when it does not exist yet, is where it says, under `root`, not reached
 * through a link to elsewhere; checked before a folder is made, so none is made outside `root`.
 */
async function assertNotLinked(root: string, dir: string, path: string): Promise<void> {
  let existing = dir;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  if (!isInside(root, await realpath(existing))) throw new Error(`${path} lies under a linked folder, which a check does not follow`);
}
