import type { CloneJob, RepoHost } from "@trackwall/protocol";
import { dirKey } from "./projects-dir.ts";

/**
 * Klonowania do folderu z projektami (§4.5, ADR-19), trzymane tylko w pamięci: po zakończeniu repo i tak jest na
 * liście z folderu, a stan po restarcie daemona odczyta się z dysku. Jeden katalog to jedno klonowanie: nowe
 * klonowanie do tej samej nazwy zastępuje zakończone, a nieudane zostaje, żeby UI mogło pokazać komunikat.
 */
export class CloneJobs {
  private readonly jobs = new Map<string, CloneJob>();

  list(): CloneJob[] {
    return [...this.jobs.values()];
  }

  /** Trwające klonowanie do katalogu o tej nazwie. */
  runningInto(dir: string): CloneJob | undefined {
    const job = this.jobs.get(dirKey(dir));
    return job?.state === "running" ? job : undefined;
  }

  /** Zaczyna `clone` w tle; wynik trafia do stanu klonowania, nie do wołającego. */
  start(dir: string, target: { host: RepoHost; fullName: string; path: string }, clone: () => Promise<void>): CloneJob {
    const key = dirKey(dir);
    const job: CloneJob = { ...target, state: "running" };
    // Ponowna próba przesuwa klonowanie na koniec listy, w kolejności rozpoczęcia.
    this.jobs.delete(key);
    this.jobs.set(key, job);
    void clone().then(
      () => this.jobs.set(key, { ...target, state: "done" }),
      (err: unknown) => this.jobs.set(key, { ...target, state: "failed", message: err instanceof Error ? err.message : String(err) }),
    );
    return job;
  }
}
