import type { EdgeSource } from "@trackwall/protocol";

/**
 * View model of the dashboard (ADR-33): the dashboard snapshot, that is what the scene shows, computed by the UI from the
 * daemon's responses.
 * The scene knows neither the API nor the state rules: it gets repo and session states ready-made (the same rules as the
 * repo list and the Sessions view), and a repo's layer from the graph layout. So the snapshot can come from polling today
 * and from `/ws` events later.
 */

/**
 * A repo's state on the dashboard, from least to most urgent: `loading` is a repo whose status has not come yet (ADR-113),
 * `unavailable` is the repo state `unavailable`,
 * `changed` is local changes, `behind` is commits to pull; a repo with only unpushed commits is `clean`.
 */
export const HOME_REPO_STATES = ["loading", "clean", "behind", "changed", "unavailable"] as const;
export type HomeRepoState = (typeof HOME_REPO_STATES)[number];

/**
 * A repo that waits for the user: the "Needs you" queue, a loud label and a strong glow. A `loading` repo does not, until its
 * status says so.
 */
export function repoNeedsYou(state: HomeRepoState): boolean {
  return state !== "clean" && state !== "loading";
}

export interface HomeRepo {
  id: string;
  /**
   * Layer from the graph (§5.5), the same as the column in "Overview": 0 is a repo nobody uses, the last one is
   * libraries. `null` for a repo without connections in the graph; such a repo gets its own arc after the last layer.
   */
  layer: number | null;
  state: HomeRepoState;
  /** Local changes for `changed`, commits to pull for `behind`; otherwise 0. */
  count: number;
  /** Name of the running mise task or `null`. */
  runningTask: string | null;
}

/**
 * A session's state on the dashboard: `attention` is "waiting for you" (`Session.needsAttention`), `idle` is `Input`
 * the user has already seen (ADR-47), `error` is a session that ended with an error, `done` a session that ended,
 * and `working` the rest, `Stale` included.
 */
export const HOME_SESSION_STATES = ["working", "attention", "idle", "error", "done"] as const;
export type HomeSessionState = (typeof HOME_SESSION_STATES)[number];

export interface HomeSession {
  id: string;
  /** The repo the session runs in (or in whose worktree it runs). */
  repo: string;
  state: HomeSessionState;
}

/** A connection from the graph: from the repo that uses to the repo that is used. */
export interface HomeLink {
  from: string;
  to: string;
  /** Where the connection comes from: the scene draws HTTP, package and manual connections differently (ADR-116). */
  source: EdgeSource;
}

export interface HomeModel {
  /** Number of graph layers (columns of "Overview"); `HomeRepo.layer` is from 0 to `layerCount - 1`. */
  layerCount: number;
  repos: readonly HomeRepo[];
  sessions: readonly HomeSession[];
  links: readonly HomeLink[];
  daemonRunning: boolean;
}

/** Key of a scene object, the same in selection events, labels and entities. */
export type HomeKey = `repo:${string}` | `session:${string}` | "daemon";

const REPO_PREFIX = "repo:";
const SESSION_PREFIX = "session:";

export const repoKey = (id: string): HomeKey => `${REPO_PREFIX}${id}`;
export const sessionKey = (id: string): HomeKey => `${SESSION_PREFIX}${id}`;
export const DAEMON_KEY: HomeKey = "daemon";

/** What a key points to; `null` for a key that is not a dashboard object (for example a wire or a layer arc). */
export type HomeTarget = { kind: "repo" | "session"; id: string } | { kind: "daemon" };

export function parseHomeKey(key: string): HomeTarget | null {
  if (key === DAEMON_KEY) return { kind: "daemon" };
  if (key.startsWith(REPO_PREFIX)) return { kind: "repo", id: key.slice(REPO_PREFIX.length) };
  if (key.startsWith(SESSION_PREFIX)) return { kind: "session", id: key.slice(SESSION_PREFIX.length) };
  return null;
}

export function isHomeKey(key: string): key is HomeKey {
  return parseHomeKey(key) !== null;
}
