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
/** HEAD and the other refs of one repo, as compared (`GitState` of `vcs`). */
interface WatchedState {
  head: string;
  refs: string;
}

/** The state of a directory without a git directory: compared like any other, so its repair is a HEAD move too. */
const NOT_A_REPO: WatchedState = { head: "not a repo", refs: "not a repo" };

/** What the watch needs from `workspace` and `vcs`; wired in the facade. */
export interface RepoWatchDeps {
  repos: { repoEntries(): Promise<RepoEntry[]> };
  /** `null`: no git directory; `undefined`: not readable this time, so its previous state stays. */
  vcs: { gitStates(dirs: readonly string[]): Promise<Map<string, (WatchedState & { usedMs: number }) | null | undefined>> };
  /** The repos that are new or whose HEAD moved in one comparison, the most recently used first. */
  onHeadMoved: (repos: RepoEntry[]) => void;
  log: (msg: string) => void;
}

export class RepoWatch {
  readonly #deps: RepoWatchDeps;
  readonly #startedAt = new Date().toISOString();
  /** The state of every repo from the previous comparison, by repo root; `undefined` before the first one. */
  #states: Map<string, WatchedState> | undefined;
  #revision = 0;
  #timer: NodeJS.Timeout | undefined;
  /** A slow drive must not stack comparisons: the next one starts only after the previous one ended. */
  #checking: Promise<void> | undefined;
  /** The last error of a comparison, so that a missing folder does not write to the log every second. */
  #failure: string | undefined;
  /** A comparison failed before the first one succeeded: the UI saw no repos then, so the first success is a change. */
  #failedFirst = false;

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
    this.#checking ??= this.#compare()
      .catch((err: unknown) => {
        if (this.#states === undefined) this.#failedFirst = true;
        throw err;
      })
      .finally(() => {
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
    const previous = this.#states;
    const current = new Map<string, WatchedState>();
    const moved: { entry: RepoEntry; usedMs: number }[] = [];
    for (const entry of entries) {
      const state = read.get(entry.path);
      const before = previous?.get(entry.path);
      // Not readable this time: as it was, or not seen yet.
      if (state === undefined) {
        if (before) current.set(entry.path, before);
        continue;
      }
      current.set(entry.path, state ?? NOT_A_REPO);
      if (state !== null && before?.head !== state.head) moved.push({ entry, usedMs: state.usedMs });
    }
    this.#states = current;
    if ((previous || this.#failedFirst) && differs(previous ?? new Map(), current)) this.#revision++;
    if (moved.length === 0) return;
    moved.sort((a, b) => b.usedMs - a.usedMs);
    this.#deps.onHeadMoved(moved.map(({ entry }) => entry));
  }
}

function differs(previous: ReadonlyMap<string, WatchedState>, current: ReadonlyMap<string, WatchedState>): boolean {
  if (current.size !== previous.size) return true;
  for (const [path, state] of current) {
    const before = previous.get(path);
    if (before?.head !== state.head || before?.refs !== state.refs) return true;
  }
  return false;
}
