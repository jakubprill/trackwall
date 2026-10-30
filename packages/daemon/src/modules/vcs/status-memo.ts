import type { RepoStatusOk } from "@trackwall/protocol";

/**
 * The repo status the lists may reuse (ADR-141). Where every process start is inspected, one `git status` takes seconds,
 * so a list of 20 repos refreshed every 30 s kept git busy for more than half of the time (#251). A list may take a
 * repo's last status again while the files of its git directory (HEAD, refs, the index) have not changed since that read
 * and it is younger than `REUSE_FACTOR` times what that read took, so git spends at most about a twentieth of the time on
 * one repo's status. Where git is fast (Linux, 20 ms for 20 repos) that window is a second, so every 30-second refresh
 * reads again; where a status takes 3 s it is a minute. A commit, checkout, fetch, staging or a `git status` in a terminal
 * (which refreshes the index) changes the key and is seen at the next list; an edit in the working directory is seen
 * when the window ends. A single repo's read (`fresh`) always runs git and renews what the lists reuse.
 */

/** How many times longer than its read a status may be reused. */
const REUSE_FACTOR = 20;
/** The shortest reuse: lists asked within a second of each other (the UI and a resumed session) share one read. */
const MIN_REUSE_MS = 1000;
/** The longest a status is reused however slow its read was, so a hung read does not freeze a repo's change count. */
const MAX_REUSE_MS = 5 * 60_000;
/** Beyond this many repos the memory starts again, so folders removed long ago do not stay for the daemon's life. */
const MAX_REPOS = 2000;

/** `recent` for a list that may reuse a status (ADR-141), `fresh` for a read that must run git. */
export type StatusRead = "recent" | "fresh";

export interface StatusMemoDeps {
  /** Monotonic milliseconds. */
  now: () => number;
  /** What git keeps about a repo's HEAD, refs and index; `undefined` when it cannot be read, and then nothing is reused. */
  gitDirKey: (dir: string) => Promise<string | undefined>;
}

interface Remembered {
  key: string;
  status: RepoStatusOk;
  reusableUntil: number;
}

export class StatusMemo {
  readonly #deps: StatusMemoDeps;
  readonly #statuses = new Map<string, Remembered>();

  constructor(deps: StatusMemoDeps) {
    this.#deps = deps;
  }

  async get(dir: string, how: StatusRead, read: () => Promise<RepoStatusOk>): Promise<RepoStatusOk> {
    // Taken before the read: a change while git runs gives another key next time, so it is never hidden.
    const key = await this.#deps.gitDirKey(dir).catch(() => undefined);
    const known = this.#statuses.get(dir);
    if (how === "recent" && key !== undefined && known?.key === key && this.#deps.now() < known.reusableUntil) return known.status;
    const startedAt = this.#deps.now();
    let status: RepoStatusOk;
    try {
      status = await read();
    } catch (err) {
      this.#statuses.delete(dir);
      throw err;
    }
    if (key === undefined) {
      this.#statuses.delete(dir);
      return status;
    }
    const took = this.#deps.now() - startedAt;
    if (!this.#statuses.has(dir) && this.#statuses.size >= MAX_REPOS) this.#statuses.clear();
    this.#statuses.set(dir, {
      key,
      status,
      reusableUntil: startedAt + Math.min(Math.max(took * REUSE_FACTOR, MIN_REUSE_MS), MAX_REUSE_MS),
    });
    return status;
  }
}
