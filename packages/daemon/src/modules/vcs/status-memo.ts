import type { RepoStatusOk, StatusRead } from "@trackwall/protocol";

/**
 * The repo status a periodic refresh may reuse (ADR-141). Where every process start is inspected, one `git status` takes
 * seconds, so a list of 20 repos refreshed every 30 s kept git busy for more than half of the time (#251). A `recent` read
 * takes a repo's last status again while the files of its git directory (HEAD, refs, the index) have not changed since
 * that read and it is younger than `REUSE_FACTOR` times what its `git status` ran (the wait for a slot not counted), so git
 * spends about a twentieth of the time on one repo's status. Where git is fast (Linux, 20 ms for 20 repos) that window is
 * the 1 s minimum, so every 30-second refresh reads again; where a status runs 3 s it is a minute. A commit, checkout,
 * fetch, staging or a `git status` in a terminal (which refreshes the index) changes the key and is seen at the next
 * refresh; an edit in the working directory is seen when the window ends. A `fresh` read always runs git and renews what
 * the `recent` ones reuse.
 */

/** How many times longer than its `git status` ran a status may be reused. */
const REUSE_FACTOR = 20;
/** The shortest reuse: lists asked within a second of each other (the UI and a resumed session) share one read. */
const MIN_REUSE_MS = 1000;
/** The longest a status is reused however slow its read was, so a hung read does not freeze a repo's change count. */
const MAX_REUSE_MS = 5 * 60_000;
/** Beyond this many repos the memory starts again, so folders removed long ago do not stay for the daemon's life. */
const MAX_REPOS = 2000;

export interface StatusMemoDeps {
  /** Monotonic milliseconds. */
  now: () => number;
  /** What git keeps about a repo's HEAD, refs and index; `undefined` when it cannot be read, and then nothing is reused. */
  gitDirKey: (dir: string) => Promise<string | undefined>;
}

/** A status and how long its `git status` itself ran, without the wait for a slot or the HEAD commit's `git log`. */
export interface TimedStatus {
  status: RepoStatusOk;
  ranMs: number;
}

interface Remembered {
  key: string;
  status: RepoStatusOk;
  /** When its read started: an older read that ends later does not replace it. */
  startedAt: number;
  reusableUntil: number;
}

export class StatusMemo {
  readonly #deps: StatusMemoDeps;
  readonly #statuses = new Map<string, Remembered>();

  constructor(deps: StatusMemoDeps) {
    this.#deps = deps;
  }

  async get(dir: string, how: StatusRead, read: () => Promise<TimedStatus>): Promise<RepoStatusOk> {
    // Taken before the read: a change while git runs gives another key next time, so it is never hidden.
    const key = await this.#deps.gitDirKey(dir).catch(() => undefined);
    const known = this.#statuses.get(dir);
    if (how === "recent" && key !== undefined && known?.key === key && this.#deps.now() < known.reusableUntil) return known.status;
    const startedAt = this.#deps.now();
    let timed: TimedStatus;
    try {
      timed = await read();
    } catch (err) {
      this.#forget(dir, startedAt);
      throw err;
    }
    if (key === undefined) {
      this.#forget(dir, startedAt);
      return timed.status;
    }
    // A read that started after this one and ended first knows more (an edit in between, which the key does not show).
    const latest = this.#statuses.get(dir);
    if (latest && latest.startedAt > startedAt) return timed.status;
    if (!latest && this.#statuses.size >= MAX_REPOS) this.#statuses.clear();
    const reuseMs = Math.min(Math.max(timed.ranMs * REUSE_FACTOR, MIN_REUSE_MS), MAX_REUSE_MS);
    this.#statuses.set(dir, { key, status: timed.status, startedAt, reusableUntil: startedAt + reuseMs });
    return timed.status;
  }

  /** Drops what a read that started at `startedAt` would have replaced, unless a later read has stored its own already. */
  #forget(dir: string, startedAt: number): void {
    const known = this.#statuses.get(dir);
    if (known && known.startedAt <= startedAt) this.#statuses.delete(dir);
  }
}
