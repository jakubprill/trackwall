import { copyFile, lstat, mkdir, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isInside } from "../../infra/path-inside.ts";

/**
 * What a reproduction check copies from a task's worktree into its own copy of the repo (ADR-227): first the task's test
 * files onto the base commit, then the rest of the task's changes. The paths come from git (the task's changed files
 * against its base), never from the agent's report; a changed path is copied as a regular file, deleted when the task
 * deleted it, and refused when it is a link or a folder (a nested repo), and neither side is reached through a linked
 * folder, so nothing outside the two folders is read or written.
 */

/** Test files by the Maven and Gradle layout: anything under a `src/test/` folder, in any module. */
const TEST_SOURCES = /(?:^|\/)src\/test\//;

/** The changed paths that go onto the base: the test sources and the reproduction test's own file. */
export function testSide(paths: readonly string[], testFile: string): { tests: string[]; rest: string[] } {
  const own = testFile.replaceAll("\\", "/");
  const tests = paths.filter((path) => path === own || TEST_SOURCES.test(path));
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
  const info = await lstat(from).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return undefined;
    throw err;
  });
  if (info === undefined) {
    await assertNotLinked(roots.to, dirname(to), path);
    await rm(to, { force: true });
    return;
  }
  if (!info.isFile())
    throw new Error(`${path} is a ${info.isSymbolicLink() ? "link" : "folder"} in the task's worktree, which a check does not copy`);
  await mkdir(dirname(to), { recursive: true });
  await assertNotLinked(roots.to, dirname(to), path);
  // The base commit may have a link there, which copying onto would follow.
  await rm(to, { force: true });
  await copyFile(from, to);
}

/** The folder is where it says, under `root`, not reached through a link to elsewhere. */
async function assertNotLinked(root: string, dir: string, path: string): Promise<void> {
  const real = await realpath(dir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return dir;
    throw err;
  });
  if (!isInside(root, real)) throw new Error(`${path} lies under a linked folder, which a check does not follow`);
}
