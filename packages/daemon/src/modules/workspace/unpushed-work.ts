import type { RepoId, UnpushedRepo, UnpushedWork } from "@trackwall/protocol";
import { messageOf } from "../../infra/errors.ts";

/**
 * The work in the projects folder that is on no remote (ADR-162), read only when the daemon runs in a container: there the
 * repos live in a Docker volume, and removing the volume or resetting Docker takes this work with it. Trackwall cannot stop
 * that, so it keeps saying how much is at stake. Outside a container the repos sit on the user's own disk, as they would
 * without Trackwall, and `Workspace.unpushedWork` reads nothing.
 */

/** What `vcs` reads of one repo (`Vcs.unpushed`), with the git directory its worktrees share as a path key. */
export type RepoUnpushedRead = Omit<UnpushedRepo, "repo"> & { commonDir: string };

/** One repo's read: its work, or why git could not read it. */
export type UnpushedRead = { repo: RepoId; work: RepoUnpushedRead } | { repo: RepoId; error: unknown };

/** The repos with unpushed work, in the order read (the list's), and the ones git could not read. */
export function unpushedWork(reads: readonly UnpushedRead[]): UnpushedWork {
  const repos: UnpushedRepo[] = [];
  const unreadable: UnpushedWork["unreadable"] = [];
  // A repo in the folder that is a worktree of another one shares its branches and worktrees: counted once, under the
  // first id in the list (sorted by name), so the total is not doubled.
  const seen = new Set<string>();
  for (const read of reads) {
    if ("error" in read) {
      unreadable.push({ repo: read.repo, message: messageOf(read.error) });
      continue;
    }
    const { commonDir, ...work } = read.work;
    if (seen.has(commonDir)) continue;
    seen.add(commonDir);
    if (work.commits + work.stashes + work.changes > 0) repos.push({ repo: read.repo, ...work });
  }
  return { inContainer: true, repos, unreadable };
}
