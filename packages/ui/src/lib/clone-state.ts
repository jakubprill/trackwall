import { type CloneJob, type RemoteRepo, type RepoHost, sameHost } from "@trackwall/protocol";

/** What a remote repo's row shows instead of the "Clone" button (ADR-19); pure functions, tests in `test/clone-state.test.ts`. */
export type CloneState =
  | { kind: "available" }
  | { kind: "in-projects-dir" }
  | { kind: "running" }
  | { kind: "done" }
  | { kind: "failed"; message: string };

/** A clone from this daemon run takes precedence over what was in the folder at search time. */
export function cloneState(host: RepoHost, repo: RemoteRepo, jobs: readonly CloneJob[]): CloneState {
  const job = jobs.findLast((j) => sameHost(j.host, host) && j.fullName === repo.fullName);
  if (job?.state === "failed") return { kind: "failed", message: job.message };
  if (job) return { kind: job.state };
  return repo.inProjectsDir ? { kind: "in-projects-dir" } : { kind: "available" };
}
