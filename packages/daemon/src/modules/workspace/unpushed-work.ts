import type { RepoId, UnpushedRepo, UnpushedWork } from "@trackwall/protocol";
import { mapLimit } from "../../infra/map-limit.ts";
import type { RepoEntry } from "./projects-dir.ts";

/**
 * The work in the projects folder that is on no remote (ADR-162), read only when the daemon runs in a container: there the
 * repos live in a Docker volume, and removing the volume or resetting Docker takes this work with it. Trackwall cannot stop
 * that, so it keeps saying how much is at stake. Outside a container the repos sit on the user's own disk, as they would
 * without Trackwall, and nothing is read.
 */

/** What `vcs` reads of one repo (`Vcs.unpushed`). */
export interface RepoUnpushedRead {
  commonDir: string;
  commits: number;
  branches: string[];
  noRemote: boolean;
  stashes: number;
  changes: number;
  changedWorktrees: number;
}

/** As many repos at once as the repo list reads (`STATUS_CONCURRENCY` of `workspace`); git's own budget queues the rest. */
const READ_CONCURRENCY = 8;

export async function unpushedWork(
  inContainer: boolean,
  entries: readonly RepoEntry[],
  read: (dir: string) => Promise<RepoUnpushedRead>,
): Promise<UnpushedWork> {
  if (!inContainer) return { inContainer, repos: [], unreadable: [] };
  const reads = await mapLimit(entries, READ_CONCURRENCY, (entry) =>
    read(entry.path).then(
      (value) => ({ id: entry.id, value }),
      () => ({ id: entry.id, value: null }),
    ),
  );
  const repos: UnpushedRepo[] = [];
  const unreadable: RepoId[] = [];
  // A repo in the folder that is a worktree of another one shares its branches and worktrees: counted once, under the
  // first id in the list (sorted by name), so the total is not doubled.
  const seen = new Set<string>();
  for (const { id, value } of reads) {
    if (value === null) {
      unreadable.push(id);
      continue;
    }
    if (seen.has(value.commonDir)) continue;
    seen.add(value.commonDir);
    const { commonDir: _, ...work } = value;
    if (work.commits + work.stashes + work.changes > 0) repos.push({ repo: id, ...work });
  }
  return { inContainer, repos, unreadable };
}
