import type { CloneJob, RepoHost } from "@trackwall/protocol";
import { messageOf } from "../../infra/errors.ts";
import { dirKey } from "./projects-dir.ts";

/**
 * Klonowania do folderu z projektami (§4.5, ADR-19), trzymane tylko w pamięci: po zakończeniu repo i tak jest na
 * liście z folderu, a stan po restarcie daemona odczyta się z dysku. Jeden katalog klonu (pełna ścieżka, bez
 * wielkości liter, bo folder z projektami można w trakcie zmienić) to jedno klonowanie: nowe
 * klonowanie do tego samego katalogu zastępuje zakończone, a nieudane zostaje, żeby UI mogło pokazać komunikat.
 */
export class CloneJobs {
  private readonly jobs = new Map<string, CloneJob>();

  list(): CloneJob[] {
    return [...this.jobs.values()];
  }

  /** Trwające klonowanie do tego katalogu. */
  runningInto(path: string): CloneJob | undefined {
    const job = this.jobs.get(dirKey(path));
    return job?.state === "running" ? job : undefined;
  }

  /** Zaczyna `clone` w tle; wynik trafia do stanu klonowania, nie do wołającego. */
  start(target: { host: RepoHost; fullName: string; path: string }, clone: () => Promise<void>): CloneJob {
    const key = dirKey(target.path);
    const job: CloneJob = { ...target, state: "running" };
    // Ponowna próba przesuwa klonowanie na koniec listy, w kolejności rozpoczęcia.
    this.jobs.delete(key);
    this.jobs.set(key, job);
    void clone().then(
      () => this.jobs.set(key, { ...target, state: "done" }),
      (err: unknown) => this.jobs.set(key, { ...target, state: "failed", message: messageOf(err) }),
    );
    return job;
  }
}
