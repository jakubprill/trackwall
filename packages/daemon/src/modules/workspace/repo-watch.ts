import type { RepoChanges } from "@trackwall/protocol";
import { messageOf } from "../../infra/errors.ts";
import { mapLimit } from "../../infra/map-limit.ts";
import type { RepoEntry } from "./projects-dir.ts";

/**
 * The repo watch (§4.5, ADR-63): every second the daemon compares the HEAD and refs of every repo in the projects folder,
 * read from the files of its git directory, and the set of repos. A change bumps the revision (`RepoChanges`, the
 * `repos.changed` topic on `/ws`), so the UI fetches the list and the graph when something changed instead of every few
 * seconds, and hands the changed repos to `onChanged` (the card warm-up). Comparing `stat` results instead of `fs.watch`:
 * a watch handle on Windows keeps a deleted repo's `.git` pending and fails the deletion of its folder, notifications do not
 * work on network drives, and a recursive watch on Linux is one inotify watch per directory. Uncommitted changes are
 * not watched on purpose: the list still polls `git status`, rarely.
 */

/** How often the repos are compared; a commit reaches the UI within this time plus the event cycle. */
const CHECK_MS = 1000;
/** How many repos are read at once: a few `stat` calls each, but the folder can lie on a network drive. */
const READ_CONCURRENCY = 16;
/** The key of a repo without a readable git directory: it is compared like any other, so its repair is a change too. */
const UNREADABLE = "unreadable";

/** What the watch needs from `workspace` and `vcs`; wired in the facade. */
export interface RepoWatchDeps {
  repos: { repoEntries(): Promise<RepoEntry[]> };
  vcs: { gitState(dir: string): Promise<{ key: string; usedMs: number } | null> };
  /** The repos that are new or whose HEAD or refs changed in one comparison, the most recently used first. */
  onChanged: (repos: RepoEntry[]) => void;
  log: (msg: string) => void;
}

export class RepoWatch {
  readonly #deps: RepoWatchDeps;
  /** The state key of every repo from the previous comparison, by repo root. */
  #keys = new Map<string, string>();
  #revision = 0;
  #timer: NodeJS.Timeout | undefined;
  /** A slow drive must not stack comparisons: the next one starts only after the previous one ended. */
  #checking: Promise<void> | undefined;
  /** The last error reading the repo list, so that a missing folder does not write to the log every second. */
  #failure: string | undefined;

  constructor(deps: RepoWatchDeps) {
    this.#deps = deps;
  }

  /** The first comparison at once (all repos are new to it), then every `intervalMs`. */
  start(intervalMs = CHECK_MS): void {
    if (this.#timer) return;
    void this.check();
    this.#timer = setInterval(() => void this.check(), intervalMs);
    this.#timer.unref();
  }

  close(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** The snapshot of the `repos.changed` topic. */
  changes(): RepoChanges {
    return { revision: this.#revision };
  }

  /** One comparison; a call during a running one waits for that one instead of starting another. */
  check(): Promise<void> {
    this.#checking ??= this.#compare().finally(() => {
      this.#checking = undefined;
    });
    return this.#checking;
  }

  async #compare(): Promise<void> {
    const entries = await this.#entries();
    const states = await mapLimit(entries, READ_CONCURRENCY, async (entry) => ({
      entry,
      state: await this.#deps.vcs.gitState(entry.path).catch(() => null),
    }));
    const keys = new Map(states.map(({ entry, state }) => [entry.path, state?.key ?? UNREADABLE]));
    const changed = states.filter(({ entry }) => this.#keys.get(entry.path) !== keys.get(entry.path));
    const removed = [...this.#keys.keys()].some((path) => !keys.has(path));
    this.#keys = keys;
    if (changed.length === 0 && !removed) return;
    this.#revision++;
    changed.sort((a, b) => (b.state?.usedMs ?? 0) - (a.state?.usedMs ?? 0));
    if (changed.length === 0) return;
    // A comparison runs from a timer: an exception here would be an unhandled rejection that ends the process under Node.
    try {
      this.#deps.onChanged(changed.map(({ entry }) => entry));
    } catch (err) {
      this.#deps.log(`handing over changed repos: ${messageOf(err)}`);
    }
  }

  /** Without a readable projects folder there are no repos to watch; the error is already shown by the list. */
  async #entries(): Promise<RepoEntry[]> {
    try {
      const entries = await this.#deps.repos.repoEntries();
      this.#failure = undefined;
      return entries;
    } catch (err) {
      const message = messageOf(err);
      if (this.#failure !== message) this.#deps.log(`repo watch cannot read the repo list: ${message}`);
      this.#failure = message;
      return [];
    }
  }
}
