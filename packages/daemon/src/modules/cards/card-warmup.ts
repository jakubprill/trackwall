import type { CardWarmupProgress } from "@trackwall/protocol";
import { messageOf } from "../../infra/errors.ts";

/**
 * The card warm-up (§4.6, ADR-63): repos whose card may be missing (all at daemon start, then the ones whose HEAD the repo
 * watch saw move) are computed in the background, a few at once, so that the first graph or `get_repo_card` after a start
 * or a commit takes the card from the cache. A request never waits for the queue: it computes its card itself (so the
 * repo open in the UI is never behind the queue), and the card cache gives both the same job. A repo handed over again
 * goes to the front; one being computed is queued again, because its HEAD has moved meanwhile.
 */

/** Remembered failures; beyond this the map starts again, so repos removed long ago do not stay for the daemon's life. */
const MAX_FAILURES = 500;
/** Two at once: the warm-up runs next to the user's work and must not take every core and the disk. */
const CONCURRENCY = 2;

export interface WarmupRepo {
  /** For the log only. */
  id: string;
  path: string;
}

export interface CardWarmupDeps {
  /** Computes the card of the repo's current HEAD (or takes it from the cache). */
  warm: (repo: WarmupRepo) => Promise<unknown>;
  log: (msg: string) => void;
  concurrency?: number;
}

export class CardWarmup {
  readonly #deps: CardWarmupDeps;
  /** Waiting repos in the order they will be computed. */
  #queue: WarmupRepo[] = [];
  #active = 0;
  #done = 0;
  #total = 0;
  #closed = false;
  /** The last error of each repo, so that a repo broken the same way does not write to the log at every commit elsewhere. */
  readonly #failures = new Map<string, string>();

  constructor(deps: CardWarmupDeps) {
    this.#deps = deps;
  }

  /** Repos to compute before the ones already waiting: the latest change is the one the user is looking at. */
  add(repos: readonly WarmupRepo[]): void {
    if (this.#closed || repos.length === 0) return;
    if (!this.progress().running) {
      this.#done = 0;
      this.#total = 0;
    }
    const paths = new Set(repos.map((repo) => repo.path));
    const waiting = this.#queue.filter((queued) => !paths.has(queued.path));
    // A repo that was already waiting is counted once.
    this.#total += repos.length - (this.#queue.length - waiting.length);
    this.#queue = [...repos, ...waiting];
    this.#pump();
  }

  progress(): CardWarmupProgress {
    return { running: this.#active > 0 || this.#queue.length > 0, done: this.#done, total: this.#total };
  }

  /** At daemon stop: nothing new starts, and a card being computed ends without a successor. */
  close(): void {
    this.#closed = true;
    this.#queue = [];
  }

  #pump(): void {
    const limit = this.#deps.concurrency ?? CONCURRENCY;
    while (!this.#closed && this.#active < limit) {
      const repo = this.#queue.shift();
      if (!repo) break;
      this.#active++;
      this.#deps
        .warm(repo)
        .then(
          () => this.#failures.delete(repo.path),
          (err: unknown) => this.#failed(repo, err),
        )
        .finally(() => {
          this.#active--;
          this.#done++;
          this.#pump();
        });
    }
  }

  /** A repo git cannot read has no card; whoever asks for it gets the error, the log gets it once. */
  #failed(repo: WarmupRepo, err: unknown): void {
    const message = messageOf(err);
    if (this.#failures.get(repo.path) === message) return;
    this.#deps.log(`card warm-up of ${repo.id}: ${message}`);
    if (this.#failures.size >= MAX_FAILURES) this.#failures.clear();
    this.#failures.set(repo.path, message);
  }
}
