import type { CloneJob, RepoHost } from "@trackwall/protocol";

/**
 * Klonowania do folderu z projektami (§4.5, ADR-19), trzymane tylko w pamięci: po zakończeniu repo i tak jest na
 * liście z folderu, a stan po restarcie daemona odczyta się z dysku. Zakończony błędem klon zostaje na liście,
 * żeby UI mogło pokazać komunikat; kolejna próba tego samego repo go zastępuje.
 */
export class CloneJobs {
  private readonly jobs = new Map<string, CloneJob>();

  list(): CloneJob[] {
    return [...this.jobs.values()].map((job) => ({ ...job }));
  }

  /** Trwające klonowanie do katalogu o tej samej nazwie (bez wielkości liter, jak na dysku Windowsa i macOS). */
  runningInto(dir: string): CloneJob | undefined {
    return [...this.jobs.values()].find((job) => job.state === "running" && sameDir(job.path, dir));
  }

  /** Zaczyna `clone` w tle; wynik trafia do stanu klonowania, nie do wołającego. */
  start(host: RepoHost, fullName: string, path: string, clone: () => Promise<void>): CloneJob {
    const key = `${host.kind}:${host.host}/${fullName}`;
    const job: CloneJob = { host, fullName, path, state: "running", message: null };
    // Ponowna próba przesuwa klonowanie na koniec listy, w kolejności rozpoczęcia.
    this.jobs.delete(key);
    this.jobs.set(key, job);
    void clone().then(
      () => {
        job.state = "done";
      },
      (err: unknown) => {
        job.state = "failed";
        job.message = err instanceof Error ? err.message : String(err);
      },
    );
    return { ...job };
  }
}

function sameDir(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
