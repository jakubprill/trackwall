import type { SyncResult, SyncRun } from "@trackwall/protocol";
import { DomainError, messageOf } from "../../infra/errors.ts";
import { mapLimit } from "../../infra/map-limit.ts";
import type { RepoEntry } from "./projects-dir.ts";

/**
 * Syncs of projects folders (§4.5, ADR-21), kept only in memory, like clones: the result shows in the repo state
 * anyway, and after a daemon restart there is nothing to resume. One sync per folder (key: the full path,
 * case-insensitive), and at most one runs at a time, in any folder: changing the folder in the meantime does not start
 * a second one on the same repos.
 */
export class SyncRuns {
  private readonly runs = new Map<string, SyncRun>();
  /** The end of each folder's last sync, for whoever has to wait for it (the day start, ADR-70). */
  private readonly ends = new Map<string, Promise<unknown>>();

  /** The last sync of the folder with key `key`. */
  last(key: string): SyncRun | undefined {
    const run = this.runs.get(key);
    return run && snapshot(run);
  }

  /**
   * Starts a sync of `entries` in the background, at most `limit` repos at once, or returns the one running in this folder; one running
   * in another folder is an error. An exception from `sync` is a `failed` result of that repo, not of the whole sync.
   */
  startOrJoin(key: string, entries: readonly RepoEntry[], limit: number, sync: (entry: RepoEntry) => Promise<SyncResult>): SyncRun {
    const running = [...this.runs].find(([, run]) => run.finishedAt === null);
    if (running?.[0] === key) return snapshot(running[1]);
    if (running) throw new DomainError("bad_request", "a sync of the previous projects folder is running");
    return snapshot(this.start(key, entries, limit, sync));
  }

  /** Like `startOrJoin`, and resolves once that sync has finished, with its results. */
  async startOrJoinAndWait(
    key: string,
    entries: readonly RepoEntry[],
    limit: number,
    sync: (entry: RepoEntry) => Promise<SyncResult>,
  ): Promise<SyncRun> {
    this.startOrJoin(key, entries, limit, sync);
    await this.ends.get(key);
    const run = this.runs.get(key);
    if (!run) throw new Error(`no sync of ${key} after its start`);
    return snapshot(run);
  }

  private start(key: string, entries: readonly RepoEntry[], limit: number, sync: (entry: RepoEntry) => Promise<SyncResult>): SyncRun {
    const run: SyncRun = {
      startedAt: new Date().toISOString(),
      finishedAt: null,
      repos: entries.map((e) => ({ repo: e.id, path: e.path, state: "waiting" })),
    };
    this.runs.set(key, run);
    const end = mapLimit(entries, limit, async (entry, i) => {
      const target = { repo: entry.id, path: entry.path };
      run.repos[i] = { ...target, state: "running" };
      try {
        run.repos[i] = { ...target, ...(await sync(entry)) };
      } catch (err) {
        run.repos[i] = { ...target, state: "failed", message: messageOf(err) };
      }
    }).finally(() => {
      run.finishedAt = new Date().toISOString();
    });
    this.ends.set(key, end);
    return run;
  }
}

/** A copy for the caller: the sync changes in the background, and the result should show one moment. */
function snapshot(run: SyncRun): SyncRun {
  return { ...run, repos: [...run.repos] };
}
