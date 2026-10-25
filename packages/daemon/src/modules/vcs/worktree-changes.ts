import { randomUUID } from "node:crypto";
import { copyFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { TaskChanges, WorkingTreeChanges } from "@trackwall/protocol";
import { mapLimit } from "../../infra/map-limit.ts";
import { git, revParse } from "./git.ts";
import { parseChangedFiles, parseNulTerminated } from "./parse.ts";
import type { RunOutput } from "./run.ts";
import { commitCount, uncommittedCount } from "./worktree.ts";

/**
 * Working directory changes against a commit, with new files and without ignored ones: a task worktree against its base
 * commit (ADR-31) and a repo from the projects folder against HEAD (ADR-34). New files go into a temporary index
 * (a copy of the working directory's index, so that git does not recount unchanged files) as an entry with the empty blob hash,
 * as with `git add --intent-to-add`, but without writing that blob to `.git/objects`. So counting changes writes nothing
 * to the repo: the agent's and the user's index stay untouched, and several windows at once do not write the same object,
 * which on Windows ended in "Permission denied" (#36). The diff runs without external diff programs and `textconv`
 * from the repo configuration.
 */

/** The empty blob hash in both git object formats (`git hash-object -t blob /dev/null`). */
const EMPTY_BLOB = new Map([
  ["sha1", "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"],
  ["sha256", "473a0f4c3be8a93681a267e3b1e9a7dcda1185436fe141f7749120a303721813"],
]);

const NUL = Buffer.from([0]);
const SLASH = "/".charCodeAt(0);
const NEWLINE = "\n".charCodeAt(0);

/** An embedded repo costs one `git rev-parse` each; processes on Windows are slow to start and scanned by the antivirus. */
const SUBMODULE_CONCURRENCY = 4;

/** Large worktrees on Windows with a scanning antivirus can take a dozen seconds or more for `git status`. */
const CHANGES_TIMEOUT_MS = 60_000;

/** Without the diff: only files with line counts, and commit counts (the MCP tool `get_session`). */
const NO_PATCH: RunOutput = { stdout: Buffer.alloc(0), truncated: false };

/**
 * Task worktree changes together with the number of task commits and uncommitted files. `maxPatchBytes` 0 skips the diff:
 * git does not compute the change contents, and `patch` is empty.
 *
 * `paths` (git pathspecs) narrows the files and the diff; the commit and uncommitted counts stay those of the whole worktree.
 */
export async function worktreeChanges(dir: string, base: string, maxPatchBytes: number, paths: readonly string[]): Promise<TaskChanges> {
  // Each one to the end: ending a task waits for this read before it deletes the worktree, so rejecting one part
  // must not leave a git still reading the directory.
  const work = [workingTreeChanges(dir, base, maxPatchBytes, paths), commitCount(dir, base, "HEAD"), uncommittedCount(dir)] as const;
  await Promise.allSettled(work);
  const [changes, commits, uncommitted] = await Promise.all(work);
  return { ...changes, commits, uncommitted };
}

/**
 * A copy of the index with the original's mtime. Git trusts an entry whose file has the recorded size and mtime unless
 * the index was written no later than that mtime ("racy git"); a fresh mtime on the copy would hide a same-size edit
 * made in the second the index was written, e.g. right after the worktree was checked out.
 */
async function copyIndex(index: string, copy: string): Promise<void> {
  try {
    const { atimeMs, mtimeMs } = await stat(index);
    await copyFile(index, copy);
    // Whole seconds: never later than the original (Node rounds a stat Date to the nearest ms), and git compares seconds.
    await utimes(copy, Math.floor(atimeMs / 1000), Math.floor(mtimeMs / 1000));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** The working directory `dir` against `base` (a commit or a tree), only under `paths` (git pathspecs; none is the whole tree). */
export async function workingTreeChanges(
  dir: string,
  base: string,
  maxPatchBytes: number,
  paths: readonly string[],
): Promise<WorkingTreeChanges> {
  const out = (await git(dir, ["rev-parse", "--git-path", "index", "--show-object-format"])).stdout.toString("utf8").trim();
  const [indexPath, objectFormat] = out.split(/\r?\n/);
  const emptyBlob = objectFormat === undefined ? undefined : EMPTY_BLOB.get(objectFormat);
  if (!indexPath || emptyBlob === undefined) throw new Error(`git rev-parse did not give the index path and a known object format: ${out}`);
  const index = resolve(dir, indexPath);
  const tmp = resolve(tmpdir(), `trackwall-index-${randomUUID()}`);
  try {
    await copyIndex(index, tmp);
    const untrackedTruncated = await addUntracked(dir, tmp, emptyBlob, paths);
    const diff = (args: string[], maxBytes?: number) =>
      git(dir, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", ...args, base, "--", ...paths], {
        indexFile: tmp,
        timeoutMs: CHANGES_TIMEOUT_MS,
        maxBytes,
      });
    // All at once, but each to the end: the temporary index can be removed only when no git reads it.
    const work = [
      diff(["--name-status", "-z"]),
      diff(["--numstat", "-z"]),
      maxPatchBytes > 0 ? diff([], maxPatchBytes) : Promise.resolve(NO_PATCH),
    ] as const;
    await Promise.allSettled(work);
    const [names, stats, patch] = await Promise.all(work);
    return {
      // The last entry of a cut list may have an incomplete path.
      files: parseChangedFiles(names.stdout.toString("utf8"), stats.stdout.toString("utf8")).slice(0, names.truncated ? -1 : undefined),
      patch: wholeLines(patch).toString("utf8"),
      // A cut file list (tens of thousands of new files without `.gitignore`) is an incomplete result too.
      truncated: patch.truncated || names.truncated || stats.truncated || untrackedTruncated,
    };
  } finally {
    // A leftover of a git killed after the time limit; a file in the temp directory is not worth hiding the error for.
    await Promise.all([tmp, `${tmp}.lock`].map((file) => rm(file, { force: true }).catch(() => {})));
  }
}

/**
 * A cut diff up to its last whole line: a newline byte is never inside a UTF-8 sequence, so the text has no half
 * character and no half line for a reader (the "Changes" tab, an agent) to take for the real content.
 */
function wholeLines({ stdout, truncated }: RunOutput): Buffer {
  return truncated ? stdout.subarray(0, stdout.lastIndexOf(NEWLINE) + 1) : stdout;
}

/**
 * New working directory files (without ignored ones) as entries of index `index` with the empty blob hash: `diff` with the working
 * directory reads their contents and mode from disk anyway, and `update-index --index-info`, unlike
 * `add --intent-to-add`, does not write the blob to `.git/objects`. Returns whether the list of new files was cut.
 */
async function addUntracked(dir: string, index: string, emptyBlob: string, paths: readonly string[]): Promise<boolean> {
  const listed = await git(dir, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...paths], {
    indexFile: index,
    timeoutMs: CHANGES_TIMEOUT_MS,
  });
  const entries = parseNulTerminated(listed.stdout);
  const fileHeader = Buffer.from(`100644 ${emptyBlob}\t`);
  const files = entries.filter((path) => path.at(-1) !== SLASH).map((path) => Buffer.concat([fileHeader, path, NUL]));
  const repos = entries.filter((path) => path.at(-1) === SLASH).map((path) => path.subarray(0, -1));
  const submodules = await mapLimit(repos, SUBMODULE_CONCURRENCY, (repo) => submoduleEntry(dir, repo, emptyBlob.length));
  const indexInfo = Buffer.concat([...files, ...submodules.filter((entry) => entry !== undefined)]);
  if (indexInfo.length > 0)
    await git(dir, ["update-index", "-z", "--index-info"], { indexFile: index, stdin: indexInfo, timeoutMs: CHANGES_TIMEOUT_MS });
  return listed.truncated;
}

/**
 * A directory with its own repo (`ls-files` gives it with a trailing `/`) is a submodule entry with that repo's HEAD, as with
 * `git add`. A repo without commits or with a hash of another length than in the task repo (another object format, SHA-1 in SHA-256)
 * is dropped, as `git add --ignore-errors` skipped them before: one bad entry would reject the whole `update-index`.
 */
async function submoduleEntry(dir: string, repo: Buffer, oidLength: number): Promise<Buffer | undefined> {
  const head = await revParse(resolve(dir, repo.toString("utf8")), "HEAD");
  if (head === undefined || head.length !== oidLength) return undefined;
  return Buffer.concat([Buffer.from(`160000 ${head}\t`), repo, NUL]);
}
