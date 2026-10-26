import type { Commit } from "@trackwall/protocol";

/** Remembered commits; beyond this the memory starts again, so repos removed long ago do not stay for the daemon's life. */
const MAX_COMMITS = 2000;

/**
 * Author, date and subject of commits by hash (ADR-79). A commit never changes, so an entry never goes stale; the repo
 * list asks for the HEAD commit of every repo at every refresh and gets it without a `git log` while HEAD stays. A read
 * running for a hash is shared, and a failed or empty one is not remembered.
 */
export class CommitMemo {
  readonly #commits = new Map<string, Promise<Commit | null>>();

  get(hash: string, read: () => Promise<Commit | null>): Promise<Commit | null> {
    const known = this.#commits.get(hash);
    if (known) return known;
    if (this.#commits.size >= MAX_COMMITS) this.#commits.clear();
    const reading = read();
    this.#commits.set(hash, reading);
    reading.then(
      (commit) => {
        if (commit === null) this.#commits.delete(hash);
      },
      () => this.#commits.delete(hash),
    );
    return reading;
  }
}
