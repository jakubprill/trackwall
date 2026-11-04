import { countLabel, type Repo, type RepoGraph, type RunningMiseTask, type Service, type Session } from "@trackwall/protocol";
import {
  type HomeKey,
  type HomeLink,
  type HomeModel,
  type HomeRepo,
  type HomeRepoState,
  type HomeService,
  type HomeServiceState,
  type HomeSessionState,
  parseHomeKey,
} from "@trackwall/scene/model";
import type { CallErrorCode } from "./api.ts";
import { changesLabel } from "./format.ts";
import { layoutGraph } from "./graph-layout.ts";
import type { StatusTone } from "./repo-status.ts";
import { repoService } from "./service-state.ts";
import { IDLE_LABEL, isIdle, STATE_LABELS, sessionStateLabel } from "./session-state.ts";

/**
 * The dashboard snapshot (ADR-33, §5.5) from daemon responses other views live on too: the repo list, sessions, the graph,
 * running mise tasks and services. The state rules are the same as in the repo list and the "Sessions" view, and a
 * repo's layer is its column in "Overview", so the dashboard differs from them in nothing it shows.
 */

export interface HomeSources {
  repos: readonly Repo[];
  sessions: readonly Session[];
  /** `undefined` while the graph is being computed: the repos then stand in one arc without connections. */
  graph: RepoGraph | undefined;
  running: readonly RunningMiseTask[];
  services: readonly Service[];
  daemonRunning: boolean;
}

export function homeModel({ repos, sessions, graph, running, services, daemonRunning }: HomeSources): HomeModel {
  const ids = new Set(repos.map((r) => r.id));
  const edges = (graph?.edges ?? []).filter((e) => ids.has(e.from) && ids.has(e.to));
  const layout = layoutGraph([...ids], edges);
  const columns = [...layout.boxes.values()].map((b) => b.column);
  return {
    layerCount: columns.length === 0 ? 0 : Math.max(...columns) + 1,
    repos: repos.map((repo) => ({
      id: repo.id,
      layer: layout.boxes.get(repo.id)?.column ?? null,
      ...repoState(repo),
      runningTask: running.find((t) => t.repo === repo.id)?.miseTask ?? null,
      service: homeService(repoService(services, repo.id)),
    })),
    // A session stands at its repo on the scene; the supervisor has none (ADR-58) and lives in its own panel.
    sessions: sessions.flatMap((s) => (s.repo !== null && ids.has(s.repo) ? [{ id: s.id, repo: s.repo, state: homeSessionState(s) }] : [])),
    links: homeLinks(edges),
    daemonRunning,
  };
}

/**
 * Unavailable, then working directory changes (like `repoStatusTone` in the repo list), then commits to pull, which the
 * repo list does not count towards the state but the dashboard does, because that is work to do too.
 */
function repoState(repo: Repo): { state: HomeRepoState; count: number } {
  const { status } = repo;
  if (status.kind === "loading") return { state: "loading", count: 0 };
  if (status.kind !== "ok") return { state: "unavailable", count: 0 };
  if (status.changes > 0) return { state: "changed", count: status.changes };
  const behind = status.upstream?.behind ?? 0;
  return behind > 0 ? { state: "behind", count: behind } : { state: "clean", count: 0 };
}

const HOME_SERVICE_STATES: Record<Service["state"], HomeServiceState | null> = {
  healthy: "ready",
  starting: "starting",
  stopping: "starting",
  unhealthy: "failing",
  crashed: "failing",
  stopped: null,
};

/** A repo's service on the dashboard (ADR-191): ready, on its way (starting or stopping), failing, or none once stopped. */
function homeService(service: Service | null): HomeService | null {
  if (service === null) return null;
  const state = HOME_SERVICE_STATES[service.state];
  return state === null ? null : { state, port: service.port };
}

/** The state of a dashboard object in one line: dot tone and text. One place for the queue, details, preview and labels. */
export interface HomeStatus {
  tone?: StatusTone;
  label: string;
}

const REPO_TONES: Record<HomeRepoState, StatusTone | undefined> = {
  loading: undefined,
  clean: "ok",
  behind: "warning",
  changed: "warning",
  unavailable: "error",
};

/** The repo state on the dashboard in the same words as the repo list, and for a repo to pull with the number of commits. */
export function homeRepoStatus(repo: HomeRepo): HomeStatus {
  const tone = REPO_TONES[repo.state];
  if (repo.state === "changed") return { tone, label: changesLabel(repo.count) ?? "changed" };
  if (repo.state === "behind") return { tone, label: pullLabel(repo.count) };
  return { tone, label: repo.state };
}

/** Commits to pull from the upstream branch: "1 commit to pull", "3 commits to pull". */
export function pullLabel(behind: number): string {
  return `${countLabel(behind, { one: "commit", other: "commits" })} to pull`;
}

/**
 * A repo's service in one line, e.g. "service ready on port 8080". Like the sessions, the dashboard shows only the
 * category; the Service panel of the repo says whether it is starting or stopping, crashed or not answering.
 */
export function homeServiceStatus(service: HomeService): HomeStatus {
  if (service.state === "ready")
    return { tone: "ok", label: service.port === null ? "service ready" : `service ready on port ${service.port}` };
  if (service.state === "starting") return { tone: "warning", label: "service starting" };
  return { tone: "error", label: "service failing" };
}

/** The words of the "Sessions" view (`STATE_LABELS`), without "probably", because the dashboard shows only the category. */
export const HOME_SESSION_STATUS: Record<HomeSessionState, HomeStatus> = {
  working: { tone: "ok", label: STATE_LABELS.Working },
  attention: { tone: "warning", label: STATE_LABELS.Input },
  idle: { label: IDLE_LABEL },
  error: { tone: "error", label: STATE_LABELS.Error },
  done: { label: STATE_LABELS.Done },
};

/**
 * The daemon is running as long as it answers and its events connection is not lost (`DaemonEvents.isLost`), which shows
 * a stop at once, while the repo list, polled every 30 s while its events are live, keeps its last answer until the next
 * request. An error with a daemon code (for example a bad `workspace.yaml`) came from it, and one without a code or with
 * `bad_response` (for example a proxy error page instead of an API envelope) is a dropped connection.
 */
export function homeDaemonRunning(error: string | undefined, errorCode: CallErrorCode | undefined, eventsLost: boolean): boolean {
  return !eventsLost && (error === undefined || (errorCode !== undefined && errorCode !== "bad_response"));
}

/**
 * Sessions, mise tasks and services run under the daemon, which stops them with itself: once its events connection is
 * lost, the last ones it reported are gone, so the dashboard does not show "working" for a daemon that has stopped. A
 * failed poll alone does not count, since the daemon may well be there. `undefined` sessions (not loaded yet) stay `undefined`.
 */
export function daemonWork(
  eventsLost: boolean,
  sessions: readonly Session[] | undefined,
  running: readonly RunningMiseTask[] | undefined,
  services: readonly Service[] | undefined,
): { sessions: readonly Session[] | undefined; running: readonly RunningMiseTask[]; services: readonly Service[] } {
  return eventsLost ? { sessions: [], running: [], services: [] } : { sessions, running: running ?? [], services: services ?? [] };
}

export function homeDaemonStatus(running: boolean): HomeStatus {
  return running ? { tone: "ok", label: "daemon running" } : { tone: "error", label: "daemon not responding" };
}

/**
 * A session's state on the dashboard from the same rules as `sessionStateLabel`: waiting for you, idle (`Input` the
 * user has seen, ADR-47), ended with an error or ended; the rest (also "not responding") is working.
 */
export function homeSessionState(session: Session): HomeSessionState {
  if (session.needsAttention) return "attention";
  const { tone } = sessionStateLabel(session);
  if (session.run.kind === "exited") return tone === "error" ? "error" : "done";
  if (isIdle(session)) return "idle";
  return session.state?.state === "Error" ? "error" : "working";
}

/**
 * The object under the key is in the dashboard snapshot; a selection of an object that disappeared (an ended session,
 * a removed repo) is dropped.
 */
export function homeHasObject(model: HomeModel, key: HomeKey): boolean {
  const target = parseHomeKey(key);
  if (target?.kind === "repo") return model.repos.some((r) => r.id === target.id);
  if (target?.kind === "session") return model.sessions.some((s) => s.id === target.id);
  return target?.kind === "daemon";
}

/** One connection per repo pair and source: several pieces of evidence for the same dependency are one wire on the scene. */
function homeLinks(edges: RepoGraph["edges"]): HomeLink[] {
  const links = new Map<string, HomeLink>();
  for (const { from, to, source } of edges) links.set(JSON.stringify([from, to, source]), { from, to, source });
  return [...links.values()];
}
