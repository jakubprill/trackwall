import { type UnpushedWork, unpushedSummary } from "@trackwall/protocol";

/**
 * The Home section "Only in this container" (ADR-162): the repos whose work is on no remote while the daemon runs in a
 * container, where removing the Docker volume or resetting Docker deletes it. Trackwall cannot stop that, so Home keeps
 * saying what is at stake. Outside a container and when everything is pushed the daemon lists nothing.
 */

export interface UnpushedRow {
  repo: string;
  /** What is unpushed: "3 commits, 1 stash"; a repo without a remote says so. */
  label: string;
  /** The row's tooltip: the branches with unpushed commits, or why git could not read the repo. */
  detail: string | undefined;
}

export function unpushedRows(work: UnpushedWork | undefined): UnpushedRow[] {
  if (!work) return [];
  const rows = work.repos.map((r) => ({
    repo: r.repo,
    label: r.noRemote ? `${unpushedSummary(r)}, no remote` : unpushedSummary(r),
    detail: r.branches.length > 0 ? `Branches: ${r.branches.join(", ")}` : undefined,
  }));
  const unreadable = work.unreadable.map((u) => ({ repo: u.repo, label: "git cannot read it", detail: u.message }));
  return [...rows, ...unreadable];
}

/** The line under the heading: why these repos are listed. */
export const UNPUSHED_NOTE = "Removing the Docker volume or resetting Docker deletes this work. Push it to keep it.";
