import type { RepoWatchState } from "@trackwall/protocol";
import { messageOf } from "../../infra/errors.ts";
import type { RepoEntry } from "./projects-dir.ts";

/**
 * The repo watch (§4.5, ADR-63): every second the daemon compares the HEAD and refs of every repo in the projects folder,
 * read from the files of its git directory, and the set of repos. A change bumps the revision (`RepoWatchState`, the
 * `repos.changed` topic on `/ws`), so the UI fetches the list and the graph when something changed instead of every few
 * seconds, and a repo that is new or whose HEAD moved goes to `onHeadMoved` (the card warm-up). Comparing `stat` results
 * instead of `fs.watch`: a watch handle on Windows keeps a deleted repo's `.git` pending and fails the deletion of its
 * folder, notifications do not work on network drives, and a recursive watch on Linux is one inotify watch per directory.
 * Uncommitted changes are not watched on purpose: the list still polls `git status`, rarely.
 */

/** How often the repos are compared; a commit reaches the UI within this time plus the event cycle. */
const CHECK_MS = 1000;
/** The key of a repo without a readable git directory: it is compared like any other, so its repair is a change too. */
const UNREADABLE = { head: "unreadable", refs: "unreadable", usedMs: 0 };

/** What the watch needs from `workspace` and `vcs`; wired in the facade. */
export interface RepoWatchDeps {
  repos: { repoEntries(): Promise<RepoEntry[]> };
  vcs: { gitStates(dirs: readonly string[]): Promise<Map<string, { head: string; refs: string; usedMs: number } | null>> };
  /** The repos that are new or whose HEAD moved in one comparison, the most recently used first. */
  onHeadMoved: (repos: RepoEntry[]) => void;
  log: (msg: string) => void;
}

export class RepoWatch {
  readonly #deps: RepoWatchDeps;
  readonly #startedAt = new Date().toISOString();
  /** The state of every repo from the previous comparison, by repo root; `undefined` before the first one. */
  #states: Map<string, { head: string; refs: string }> | undefined;
  #revision = 0;
  #timer: NodeJS.Timeout | undefined;
  /** A slow drive must not stack comparisons: the next one starts only after the previous one ended. */
  #checking: Promise<void> | undefined;
  /** The last error of a comparison, so that a missing folder does not write to the log every second. */
  #failure: string | undefined;

  constructor(deps: RepoWatchDeps) {
    this.#deps = deps;
  }

  /** The first comparison at once (it hands every repo over and sets revision 0), then every `intervalMs`. */
  start(intervalMs = CHECK_MS): void {
    if (this.#timer) return;
    this.#tick();
    this.#timer = setInterval(() => this.#tick(), intervalMs);
    this.#timer.unref();
  }

  close(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** The snapshot of the `repos.changed` topic. */
  state(): RepoWatchState {
    return { startedAt: this.#startedAt, revision: this.#revision };
  }

  /** One comparison; a call during a running one gets that one instead of starting another. */
  check(): Promise<void> {
    this.#checking ??= this.#compare().finally(() => {
      this.#checking = undefined;
    });
    return this.#checking;
  }

  /** From a timer an exception would be an unhandled rejection, which ends the process under Node. */
  #tick(): void {
    this.check().then(
      () => {
        this.#failure = undefined;
      },
      (err: unknown) => {
        const message = messageOf(err);
        if (this.#failure !== message) this.#deps.log(`repo watch: ${message}`);
        this.#failure = message;
      },
    );
  }

  /**
   * A repo list that cannot be read (a missing folder, a bad `workspace.yaml` saved for a moment) throws before anything
   * is compared: the previous states stay, so the folder coming back is no change and does not warm every repo up again.
   */
  async #compare(): Promise<void> {
    const entries = await this.#deps.repos.repoEntries();
    const read = await this.#deps.vcs.gitStates(entries.map((entry) => entry.path));
    const states = entries.map((entry) => ({ entry, state: read.get(entry.path) ?? UNREADABLE }));
    const previous = this.#states;
    this.#states = new Map(states.map(({ entry, state }) => [entry.path, { head: state.head, refs: state.refs }]));
    const moved = states.filter(({ entry, state }) => previous?.get(entry.path)?.head !== state.head);
    if (previous && this.#differs(previous)) this.#revision++;
    if (moved.length === 0) return;
    moved.sort((a, b) => b.state.usedMs - a.state.usedMs);
    this.#deps.onHeadMoved(moved.map(({ entry }) => entry));
  }

  #differs(previous: Map<string, { head: string; refs: string }>): boolean {
    const current = this.#states ?? new Map();
    if (current.size !== previous.size) return true;
    for (const [path, state] of current) {
      const before = previous.get(path);
      if (before?.head !== state.head || before?.refs !== state.refs) return true;
    }
    return false;
  }
}
