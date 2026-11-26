import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { mapLimit } from "../../infra/map-limit.ts";

/**
 * Whether any of a worktree's changed files was written after a moment (ADR-304): the "Tests" tab says its reports may
 * be about earlier changes. Modification times, not content, because the reports carry only theirs; a deleted file has
 * none and does not count, nor does a link, whose own time is not its target's.
 */

/** Files looked at once: each one is a read of the disk, which an antivirus scans on Windows. */
const STAT_CONCURRENCY = 8;

export async function writtenSince(worktree: string, paths: readonly string[], sinceMs: number): Promise<boolean> {
  const times = await mapLimit(paths, STAT_CONCURRENCY, async (path) => {
    const info = await lstat(resolve(worktree, path)).catch(() => undefined);
    return info?.isFile() ? info.mtimeMs : Number.NEGATIVE_INFINITY;
  });
  return times.some((ms) => ms > sinceMs);
}
