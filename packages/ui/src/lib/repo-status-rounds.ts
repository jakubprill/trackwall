import type { Repo, StatusRead } from "@trackwall/protocol";
import { type CallErrorCode, errorCode, errorMessage } from "./api.ts";

/**
 * Lazy loading of the repo list (ADR-113): the quick list (`entries`) has every repo as `loading`, and rounds of `repos`
 * requests bring the statuses in batches, the repos the view shows first. `useRepoList` drives it from React.
 */

/** How many repos one `repos` request asks for: two rounds of git slots on Windows, so the first answer comes soon. */
const REPO_BATCH_SIZE = 8;

/**
 * The repos of the list in batches of `size`: those in `first` that are on the list, in that order, then the rest in list
 * order. Every repo once.
 */
export function repoBatches(ids: readonly string[], first: readonly string[], size: number): string[][] {
  const listed = new Set(ids);
  const front = [...new Set(first)].filter((id) => listed.has(id));
  const taken = new Set(front);
  const order = [...front, ...ids.filter((id) => !taken.has(id))];
  const batches: string[][] = [];
  for (let i = 0; i < order.length; i += size) batches.push(order.slice(i, i + size));
  return batches;
}

/**
 * The quick list with every repo whose status has come replaced by it; the rest stay `loading`, in the list's order. A
 * status counts only for the same folder: a repo of another projects folder with the same id is not this one.
 */
export function withLoadedRepos(entries: readonly Repo[], loaded: ReadonlyMap<string, Repo>): Repo[] {
  return entries.map((entry) => {
    const repo = loaded.get(entry.id);
    return repo?.path === entry.path ? repo : entry;
  });
}

/** Why the last batch failed, with the daemon's code when it answered, so a view can tell a daemon error from no daemon. */
export interface RepoStatusError {
  message: string;
  code?: CallErrorCode;
}

/** What the rounds need from the view: the request, the repos to ask first, and a call when the list has changed. */
export interface RepoStatusSource {
  /** `read` is `fresh` for a refresh the user asked for, `recent` for the periodic one (ADR-141). */
  fetch: (ids: string[], read: StatusRead) => Promise<Repo[]>;
  first: () => readonly string[];
  changed: () => void;
}

/**
 * One round at a time: a quick list that comes during a round waits for its end and then starts one more round, however
 * many came, so a list refreshed faster than git reads it still reaches its last repo. A failed batch ends the round with
 * its error, which the next successful batch, or a round with nothing to read, clears.
 */
export class RepoStatusRounds {
  readonly #source: RepoStatusSource;
  readonly #loaded = new Map<string, Repo>();
  #entries: readonly Repo[] = [];
  #running = false;
  #again = false;
  /** How the next round reads: `fresh` when any refresh since the last round started was the user's. */
  #nextRead: StatusRead = "recent";
  #stopped = false;
  #error: RepoStatusError | undefined;

  constructor(source: RepoStatusSource) {
    this.#source = source;
  }

  /** The list to show: the latest quick list with the statuses that have come. */
  get repos(): Repo[] {
    return withLoadedRepos(this.#entries, this.#loaded);
  }

  get error(): RepoStatusError | undefined {
    return this.#error;
  }

  refresh(entries: readonly Repo[], read: StatusRead): void {
    if (this.#stopped) return;
    this.#entries = entries;
    if (read === "fresh") this.#nextRead = "fresh";
    this.#source.changed();
    if (this.#running) {
      this.#again = true;
      return;
    }
    void this.#run();
  }

  /** No more requests or calls: the view is gone or has another connection. */
  stop(): void {
    this.#stopped = true;
  }

  async #run(): Promise<void> {
    this.#running = true;
    do {
      this.#again = false;
      const read = this.#nextRead;
      this.#nextRead = "recent";
      await this.#round(this.#entries, read);
    } while (this.#again && !this.#stopped);
    this.#running = false;
  }

  async #round(entries: readonly Repo[], read: StatusRead): Promise<void> {
    const ids = entries.map((entry) => entry.id);
    const listed = new Set(ids);
    for (const id of this.#loaded.keys()) if (!listed.has(id)) this.#loaded.delete(id);
    for (const batch of repoBatches(ids, this.#source.first(), REPO_BATCH_SIZE)) {
      if (!(await this.#load(batch, read))) return;
    }
    if (this.#error && !this.#stopped) {
      this.#error = undefined;
      this.#source.changed();
    }
  }

  /** One batch; `false` ends the round. */
  async #load(batch: string[], read: StatusRead): Promise<boolean> {
    try {
      const repos = await this.#source.fetch(batch, read);
      if (this.#stopped) return false;
      for (const repo of repos) this.#loaded.set(repo.id, repo);
      this.#error = undefined;
      this.#source.changed();
      return true;
    } catch (err) {
      if (this.#stopped) return false;
      this.#error = { message: errorMessage(err), code: errorCode(err) };
      this.#source.changed();
      return false;
    }
  }
}
