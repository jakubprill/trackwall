import type { SyncOutcome, SyncRepo, SyncRun } from "@trackwall/protocol";
import { mapLimit } from "./map-limit.ts";
import type { RepoEntry } from "./projects-dir.ts";

/**
 * Synchronizacje folderów z projektami (§4.5, ADR-21), trzymane tylko w pamięci, jak klonowania: wynik i tak widać
 * w stanie repo, a po restarcie daemona nie ma czego wznawiać. Jedna synchronizacja na folder (pełna ścieżka bez
 * wielkości liter); naraz trwa co najwyżej jedna, bo dwie na tym samym repo walczyłyby o te same refy.
 */
export class SyncRuns {
  private readonly runs = new Map<string, SyncRun>();
  private running: string | undefined;

  /** Ostatnia synchronizacja folderu o kluczu `key`. */
  last(key: string): SyncRun | undefined {
    const run = this.runs.get(key);
    return run && snapshot(run);
  }

  /** Trwająca synchronizacja, w dowolnym folderze, z kluczem folderu. */
  current(): { key: string; run: SyncRun } | undefined {
    const key = this.running;
    const run = key === undefined ? undefined : this.last(key);
    return key !== undefined && run ? { key, run } : undefined;
  }

  /**
   * Zaczyna synchronizację `entries` w tle, najwyżej `limit` repo naraz; wyjątek z `sync` to wynik `failed`
   * tego repo, nie całej synchronizacji.
   */
  start(key: string, entries: readonly RepoEntry[], limit: number, sync: (entry: RepoEntry) => Promise<SyncOutcome>): SyncRun {
    const run: SyncRun = {
      startedAt: new Date().toISOString(),
      finishedAt: null,
      repos: entries.map((e) => ({ repo: e.id, path: e.path, state: "waiting" })),
    };
    this.runs.set(key, run);
    this.running = key;
    const settle = (i: number, state: SyncRepo) => {
      run.repos[i] = state;
    };
    const indexed = entries.map((entry, i) => ({ entry, i }));
    void mapLimit(indexed, limit, async ({ entry, i }) => {
      const target = { repo: entry.id, path: entry.path };
      settle(i, { ...target, state: "running" });
      try {
        settle(i, { ...target, ...(await sync(entry)) });
      } catch (err) {
        settle(i, { ...target, state: "failed", message: err instanceof Error ? err.message : String(err) });
      }
    }).finally(() => {
      run.finishedAt = new Date().toISOString();
      this.running = undefined;
    });
    return snapshot(run);
  }
}

/** Kopia dla wołającego: synchronizacja zmienia się w tle, a wynik ma pokazać jedną chwilę. */
function snapshot(run: SyncRun): SyncRun {
  return { ...run, repos: [...run.repos] };
}
