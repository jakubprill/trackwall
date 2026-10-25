import type { RepoWatchState } from "@trackwall/protocol";

/**
 * Data that depends on the repos' commits (the list, tags, the graph) is fetched when the repo watch reports a change
 * (`repos.changed`, ADR-63), and polled only as a safety net. Without an event connection the views poll as often as
 * before the watch existed.
 */

/** How often a view polls: with live repo events and without them. */
export interface RepoPollPace {
  live: number;
  polled: number;
}

/**
 * The repo list carries the working directory state, which the watch does not see (`git status`, §4.5), so it still polls,
 * only less often while commits come as events.
 */
export const REPO_LIST_PACE: RepoPollPace = { live: 30_000, polled: 10_000 };
/** Tags change with commits and with a hand edit of the rules in `workspace.yaml`, which no event reports. */
export const REPO_TAGS_PACE: RepoPollPace = { live: 5 * 60_000, polled: 60_000 };
/** The graph changes with commits and with a hand edit of the `graph` entries in `workspace.yaml`. */
export const GRAPH_PACE: RepoPollPace = { live: 5 * 60_000, polled: 30_000 };

/**
 * Counts the repo changes the UI has to react to: the first snapshot of a connection only sets the start, and the same
 * state again (a reconnect to the same daemon) is no change. A restarted daemon has another `startedAt`, and that counts
 * as a change, because the repos may have changed meanwhile.
 */
export class RepoChangeCounter {
  #last: string | undefined;
  #count = 0;

  /** The count after this snapshot. */
  see(state: RepoWatchState): number {
    const key = `${state.startedAt}#${state.revision}`;
    if (this.#last !== undefined && this.#last !== key) this.#count++;
    this.#last = key;
    return this.#count;
  }
}
