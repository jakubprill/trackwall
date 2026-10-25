import type { CloneJob, RepoHost } from "@trackwall/protocol";
import { messageOf } from "../../infra/errors.ts";
import { dirKey } from "./projects-dir.ts";

/**
 * Clones into the projects folder (§4.5, ADR-19), kept only in memory: when one finishes the repo is on the
 * folder's list anyway, and after a daemon restart the state is read from disk. One clone directory (the full path,
 * case-insensitive, because the projects folder can change in the meantime) is one clone: a new
 * clone into the same directory replaces a finished one, and a failed one stays so that the UI can show the message.
 */
export class CloneJobs {
  private readonly jobs = new Map<string, CloneJob>();

  list(): CloneJob[] {
    return [...this.jobs.values()];
  }

  /** The running clone into this directory. */
  runningInto(path: string): CloneJob | undefined {
    const job = this.jobs.get(dirKey(path));
    return job?.state === "running" ? job : undefined;
  }

  /** Starts `clone` in the background; the result goes into the clone state, not to the caller. */
  start(target: { host: RepoHost; fullName: string; path: string }, clone: () => Promise<void>): CloneJob {
    const key = dirKey(target.path);
    const job: CloneJob = { ...target, state: "running" };
    // A retry moves the clone to the end of the list, in order of start.
    this.jobs.delete(key);
    this.jobs.set(key, job);
    void clone().then(
      () => this.jobs.set(key, { ...target, state: "done" }),
      (err: unknown) => this.jobs.set(key, { ...target, state: "failed", message: messageOf(err) }),
    );
    return job;
  }
}
