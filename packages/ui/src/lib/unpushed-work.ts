import { type UnpushedWork, unpushedSummary } from "@trackwall/protocol";

/**
 * The Home section "Only in this container" (ADR-162): the repos whose work is on no remote while the daemon runs in a
 * container, where removing the Docker volume or resetting Docker deletes it. Trackwall cannot stop that, so Home keeps
 * saying what is at stake. Nothing to show outside a container or when everything is pushed.
 */
export interface UnpushedRow {
  repo: string;
  /** What is unpushed: "3 commits, 1 stash"; a repo without a remote says so. */
  label: string;
  /** The local branches with unpushed commits, for the row's tooltip. */
  branches: string[];
}

export function unpushedRows(work: UnpushedWork | undefined): UnpushedRow[] {
  if (!work?.inContainer) return [];
  const rows = work.repos.map((r) => ({
    repo: r.repo,
    label: r.noRemote ? `${unpushedSummary(r)}, no remote` : unpushedSummary(r),
    branches: r.branches,
  }));
  const unreadable = work.unreadable.map((repo) => ({ repo, label: "git cannot read it", branches: [] }));
  return [...rows, ...unreadable];
}

/** The line under the heading: why these repos are listed. */
export const UNPUSHED_NOTE = "Removing the Docker volume or resetting Docker deletes this work. Push it to keep it.";
