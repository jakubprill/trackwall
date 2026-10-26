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
  /** Each folder's last sync, and its end for whoever has to wait for it (the day start, ADR-70). */
  private readonly runs = new Map<string, { run: SyncRun; end: Promise<unknown> }>();

  /** The last sync of the folder with key `key`. */
  last(key: string): SyncRun | undefined {
    const entry = this.runs.get(key);
    return entry && snapshot(entry.run);
  }

  /**
   * Starts a sync of `entries` in the background, at most `limit` repos at once, or returns the one running in this folder; one running
   * in another folder is an error. An exception from `sync` is a `failed` result of that repo, not of the whole sync.
   */
  startOrJoin(key: string, entries: readonly RepoEntry[], limit: number, sync: (entry: RepoEntry) => Promise<SyncResult>): SyncRun {
    return snapshot(this.join(key, entries, limit, sync).run);
  }

  /** Like `startOrJoin`, and resolves once that sync has finished, with its results. */
  async startOrJoinAndWait(
    key: string,
    entries: readonly RepoEntry[],
    limit: number,
    sync: (entry: RepoEntry) => Promise<SyncResult>,
  ): Promise<SyncRun> {
    const { run, end } = this.join(key, entries, limit, sync);
    await end;
    return snapshot(run);
  }

  private join(
    key: string,
    entries: readonly RepoEntry[],
    limit: number,
    sync: (entry: RepoEntry) => Promise<SyncResult>,
  ): { run: SyncRun; end: Promise<unknown> } {
    const running = [...this.runs].find(([, entry]) => entry.run.finishedAt === null);
    if (running?.[0] === key) return running[1];
    if (running) throw new DomainError("bad_request", "a sync of the previous projects folder is running");
    return this.start(key, entries, limit, sync);
  }

  private start(
    key: string,
    entries: readonly RepoEntry[],
    limit: number,
    sync: (entry: RepoEntry) => Promise<SyncResult>,
  ): { run: SyncRun; end: Promise<unknown> } {
    const run: SyncRun = {
      startedAt: new Date().toISOString(),
      finishedAt: null,
      repos: entries.map((e) => ({ repo: e.id, path: e.path, state: "waiting" })),
    };
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
    const started = { run, end };
    this.runs.set(key, started);
    return started;
  }
}

/** A copy for the caller: the sync changes in the background, and the result should show one moment. */
function snapshot(run: SyncRun): SyncRun {
  return { ...run, repos: [...run.repos] };
}
