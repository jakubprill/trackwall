import { countLabel, type Repo, type RepoGraph, type RunningMiseTask, type Session } from "@trackwall/protocol";
import {
  type HomeKey,
  type HomeLink,
  type HomeModel,
  type HomeRepo,
  type HomeRepoState,
  type HomeSessionState,
  parseHomeKey,
} from "@trackwall/scene/model";
import type { CallErrorCode } from "./api.ts";
import { changesLabel } from "./format.ts";
import { layoutGraph } from "./graph-layout.ts";
import type { StatusTone } from "./repo-status.ts";
import { IDLE_LABEL, isIdle, STATE_LABELS, sessionStateLabel } from "./session-state.ts";

/**
 * The dashboard snapshot (ADR-33, §5.5) from daemon responses other views live on too: the repo list, sessions, the graph
 * and running mise tasks. The state rules are the same as in the repo list and the "Sessions" view, and a repo's layer is
 * its column in "Overview", so the dashboard differs from them in nothing it shows.
 */

export interface HomeSources {
  repos: readonly Repo[];
  sessions: readonly Session[];
  /** `undefined` while the graph is being computed: the repos then stand in one arc without connections. */
  graph: RepoGraph | undefined;
  running: readonly RunningMiseTask[];
  daemonRunning: boolean;
}

export function homeModel({ repos, sessions, graph, running, daemonRunning }: HomeSources): HomeModel {
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
  if (status.kind !== "ok") return { state: "unavailable", count: 0 };
  if (status.changes > 0) return { state: "changed", count: status.changes };
  const behind = status.upstream?.behind ?? 0;
  return behind > 0 ? { state: "behind", count: behind } : { state: "clean", count: 0 };
}

/** The state of a dashboard object in one line: dot tone and text. One place for the queue, details, preview and labels. */
export interface HomeStatus {
  tone?: StatusTone;
  label: string;
}

const REPO_TONES: Record<HomeRepoState, StatusTone> = { clean: "ok", behind: "warning", changed: "warning", unavailable: "error" };

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

/** The words of the "Sessions" view (`STATE_LABELS`), without "probably", because the dashboard shows only the category. */
export const HOME_SESSION_STATUS: Record<HomeSessionState, HomeStatus> = {
  working: { tone: "ok", label: STATE_LABELS.Working },
  attention: { tone: "warning", label: STATE_LABELS.Input },
  idle: { label: IDLE_LABEL },
  error: { tone: "error", label: STATE_LABELS.Error },
  done: { label: STATE_LABELS.Done },
};

/**
 * The daemon is running as long as it answers: an error with a daemon code (for example a bad `workspace.yaml`) came
 * from it, and one without a code or with `bad_response` (for example a proxy error page instead of an API envelope) is
 * a dropped connection.
 */
export function daemonAnswered(error: string | undefined, errorCode: CallErrorCode | undefined): boolean {
  return error === undefined || (errorCode !== undefined && errorCode !== "bad_response");
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

/** The object under the key is in the snapshot; a selection of an object that disappeared (an ended session, a removed repo) is dropped. */
export function homeHasObject(model: HomeModel, key: HomeKey): boolean {
  const target = parseHomeKey(key);
  if (target?.kind === "repo") return model.repos.some((r) => r.id === target.id);
  if (target?.kind === "session") return model.sessions.some((s) => s.id === target.id);
  return target?.kind === "daemon";
}

/** One connection per repo pair and kind: several pieces of evidence for the same dependency are one wire on the scene. */
function homeLinks(edges: RepoGraph["edges"]): HomeLink[] {
  const links = new Map<string, HomeLink>();
  for (const { from, to, kind } of edges) links.set(JSON.stringify([from, to, kind]), { from, to, kind });
  return [...links.values()];
}
