import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Session, Task } from "@trackwall/protocol";

/**
 * What the cleanup of old task worktrees (ADR-210, §4.4) reads about a task besides git: when it was last active, and how
 * much disk its worktree takes. Reads only: the cleanup ends a task through the task end, which deletes nothing it
 * would lose without the user's confirmation.
 */

/** A worktree with `node_modules` has hundreds of thousands of files; the count stops there and says it is a lower bound. */
const SIZE_MAX_ENTRIES = 500_000;
/** Each `lstat` is scanned by an antivirus on Windows, so the count also stops after this long. */
const SIZE_MAX_MS = 20_000;
/** Entries of one directory measured at once. */
const SIZE_BATCH = 64;

/**
 * The newest moment the task did something that the daemon can see: its start, its last report, its worktree's newest
 * commit and its listed sessions' starts and ends; a session that runs is active now.
 */
export function lastActivity(
  task: Pick<Task, "createdAt" | "summary">,
  sessions: readonly Session[],
  lastCommitAt: string | null,
  now: Date,
): string {
  const moments = [task.createdAt, task.summary?.reportedAt, lastCommitAt];
  for (const session of sessions) {
    moments.push(session.startedAt);
    moments.push(session.run.kind === "exited" ? session.run.endedAt : now.toISOString());
  }
  const newest = Math.max(
    ...moments
      .filter((m) => m !== null && m !== undefined)
      .map((m) => Date.parse(m))
      .filter(Number.isFinite),
  );
  if (!Number.isFinite(newest)) throw new Error(`task created at ${task.createdAt} has no readable moment of activity`);
  return new Date(newest).toISOString();
}

/** Where the count of a worktree's size stops: after so many entries or so long, or when `stop` says so (the task ends). */
interface SizeLimits {
  maxEntries: number;
  maxMs: number;
  stop: () => boolean;
}

/**
 * The bytes of every file under `dir`, ignored ones included, without following a link or a junction (on Windows a
 * junction is a link to Node), so a link out of the worktree is not counted; `dir` itself must be a real folder. A
 * directory or file that vanishes or cannot be read meanwhile is skipped. `complete` is `false` when the count stopped
 * at a limit.
 */
export async function folderSize(dir: string, limits: Partial<SizeLimits> = {}): Promise<{ bytes: number; complete: boolean }> {
  const { maxEntries = SIZE_MAX_ENTRIES, maxMs = SIZE_MAX_MS, stop = () => false } = limits;
  const root = await lstat(dir);
  if (!root.isDirectory()) throw new Error(`${dir} is not a folder`);
  const deadline = performance.now() + maxMs;
  const pending = [dir];
  let bytes = 0;
  let entries = 0;
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const children = await readdir(next, { withFileTypes: true }).catch(() => [] as Dirent[]);
    for (let i = 0; i < children.length; i += SIZE_BATCH) {
      if (entries >= maxEntries || performance.now() > deadline || stop()) return { bytes, complete: false };
      const batch = children.slice(i, i + SIZE_BATCH);
      entries += batch.length;
      for (const child of batch) if (child.isDirectory()) pending.push(join(next, child.name));
      bytes += await filesBytes(next, batch);
    }
  }
  return { bytes, complete: true };
}

async function filesBytes(dir: string, entries: readonly Dirent[]): Promise<number> {
  const sizes = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map((file) =>
        lstat(join(dir, file.name)).then(
          (info) => info.size,
          () => 0,
        ),
      ),
  );
  return sizes.reduce((sum, size) => sum + size, 0);
}
