import type { CardWarmup as CardWarmupProgress } from "@trackwall/protocol";

/**
 * The card warm-up (§4.6, ADR-63): repos whose card may be missing (all at daemon start, then the ones the repo watch saw
 * change) are computed in the background, a few at once, so that the first graph or `get_repo_card` after a start or a
 * commit takes the card from the cache. A request never waits for the queue: it computes its card itself, and the card
 * cache gives both the same job. A repo handed over again while it is queued keeps its place; one being computed is queued
 * again, because its HEAD has moved meanwhile.
 */

/** Two at once: the warm-up runs next to the user's work and must not take every core and the disk. */
const CONCURRENCY = 2;

export interface WarmupRepo {
  id: string;
  path: string;
}

export interface CardWarmupDeps {
  /** Computes the card of the repo's current HEAD (or takes it from the cache); an error belongs to that repo only. */
  warm: (repo: WarmupRepo) => Promise<void>;
  concurrency?: number;
}

export class CardWarmup {
  readonly #deps: CardWarmupDeps;
  /** Waiting repos by root, in the order they will be computed. */
  #queue: WarmupRepo[] = [];
  #active = 0;
  #done = 0;
  #total = 0;

  constructor(deps: CardWarmupDeps) {
    this.#deps = deps;
  }

  /** Repos to compute before the ones already waiting (the latest change is the one the user is looking at). */
  add(repos: readonly WarmupRepo[]): void {
    const fresh = repos.filter((repo) => !this.#queue.some((queued) => queued.path === repo.path));
    if (fresh.length === 0) return;
    if (this.#active === 0 && this.#queue.length === 0) {
      this.#done = 0;
      this.#total = 0;
    }
    this.#queue = [...fresh, ...this.#queue];
    this.#total += fresh.length;
    this.#pump();
  }

  progress(): CardWarmupProgress {
    return { running: this.#active > 0 || this.#queue.length > 0, done: this.#done, total: this.#total };
  }

  #pump(): void {
    const limit = this.#deps.concurrency ?? CONCURRENCY;
    while (this.#active < limit) {
      const repo = this.#queue.shift();
      if (!repo) break;
      this.#active++;
      // `warm` handles its own errors; the catch only keeps a bug in it from ending the warm-up.
      void this.#deps
        .warm(repo)
        .catch(() => {})
        .finally(() => {
          this.#active--;
          this.#done++;
          this.#pump();
        });
    }
  }
}
