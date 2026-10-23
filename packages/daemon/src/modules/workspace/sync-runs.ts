import type { SyncResult, SyncRun } from "@trackwall/protocol";
import { DomainError, messageOf } from "../../errors.ts";
import { mapLimit } from "../../map-limit.ts";
import type { RepoEntry } from "./projects-dir.ts";

/**
 * Synchronizacje folderów z projektami (§4.5, ADR-21), trzymane tylko w pamięci, jak klonowania: wynik i tak widać
 * w stanie repo, a po restarcie daemona nie ma czego wznawiać. Jedna synchronizacja na folder (klucz: pełna ścieżka
 * bez wielkości liter), a naraz trwa co najwyżej jedna, w dowolnym folderze: zmiana folderu w trakcie nie zaczyna
 * drugiej na tych samych repo.
 */
export class SyncRuns {
  private readonly runs = new Map<string, SyncRun>();

  /** Ostatnia synchronizacja folderu o kluczu `key`. */
  last(key: string): SyncRun | undefined {
    const run = this.runs.get(key);
    return run && snapshot(run);
  }

  /**
   * Zaczyna synchronizację `entries` w tle, najwyżej `limit` repo naraz, albo zwraca trwającą w tym folderze; trwająca
   * w innym folderze to błąd. Wyjątek z `sync` to wynik `failed` tego repo, nie całej synchronizacji.
   */
  startOrJoin(key: string, entries: readonly RepoEntry[], limit: number, sync: (entry: RepoEntry) => Promise<SyncResult>): SyncRun {
    const running = [...this.runs].find(([, run]) => run.finishedAt === null);
    if (running?.[0] === key) return snapshot(running[1]);
    if (running) throw new DomainError("bad_request", "trwa synchronizacja poprzedniego folderu z projektami");
    return snapshot(this.start(key, entries, limit, sync));
  }

  private start(key: string, entries: readonly RepoEntry[], limit: number, sync: (entry: RepoEntry) => Promise<SyncResult>): SyncRun {
    const run: SyncRun = {
      startedAt: new Date().toISOString(),
      finishedAt: null,
      repos: entries.map((e) => ({ repo: e.id, path: e.path, state: "waiting" })),
    };
    this.runs.set(key, run);
    void mapLimit(entries, limit, async (entry, i) => {
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
    return run;
  }
}

/** Kopia dla wołającego: synchronizacja zmienia się w tle, a wynik ma pokazać jedną chwilę. */
function snapshot(run: SyncRun): SyncRun {
  return { ...run, repos: [...run.repos] };
}
