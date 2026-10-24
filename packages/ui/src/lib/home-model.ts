import { countLabel, type Repo, type RepoGraph, type RunningMiseTask, type Session } from "@trackwall/protocol";
import type { HomeLink, HomeModel, HomeRepo, HomeRepoState, HomeSessionState } from "@trackwall/scene/model";
import { changesLabel } from "./format.ts";
import { layoutGraph } from "./graph-layout.ts";
import { sessionStateLabel } from "./session-state.ts";

/**
 * Migawka pulpitu (ADR-33, §5.5) z odpowiedzi daemona, którymi żyją też inne widoki: lista repo, sesje, graf
 * i działające taski mise. Reguły stanu są te same co na liście repo i w widoku „Sessions”, a warstwa repo to kolumna
 * z „Overview”, więc pulpit nie różni się od nich w niczym, co pokazuje.
 */

export interface HomeSources {
  repos: readonly Repo[];
  sessions: readonly Session[];
  /** `undefined`, dopóki graf się liczy: repo stoją wtedy w jednym łuku bez połączeń. */
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
    sessions: sessions.filter((s) => ids.has(s.repo)).map((s) => ({ id: s.id, repo: s.repo, state: homeSessionState(s) })),
    links: homeLinks(edges),
    daemonRunning,
  };
}

/** Ta sama kolejność co `repoStatusTone`: niedostępne, potem zmiany w katalogu roboczym, potem commity do pobrania. */
function repoState(repo: Repo): { state: HomeRepoState; count: number } {
  const { status } = repo;
  if (status.kind !== "ok") return { state: "unavailable", count: 0 };
  if (status.changes > 0) return { state: "changed", count: status.changes };
  const behind = status.upstream?.behind ?? 0;
  return behind > 0 ? { state: "behind", count: behind } : { state: "clean", count: 0 };
}

/** Stan repo z pulpitu jednym tekstem, tymi samymi słowami co lista repo. */
export function homeRepoStateText(repo: HomeRepo): string {
  if (repo.state === "changed") return changesLabel(repo.count) ?? "changed";
  if (repo.state === "behind") return `${countLabel(repo.count, { one: "commit", other: "commits" })} to pull`;
  return repo.state;
}

/**
 * Stan sesji na pulpicie z tych samych reguł co `sessionStateLabel`: czekająca na Ciebie, zakończona błędem albo
 * zakończona; reszta (także „not responding”) pracuje.
 */
export function homeSessionState(session: Session): HomeSessionState {
  if (session.needsAttention) return "attention";
  const { tone } = sessionStateLabel(session);
  if (session.run.kind === "exited") return tone === "error" ? "error" : "done";
  return session.state?.state === "Error" ? "error" : "working";
}

/** Jedno połączenie na parę repo i rodzaj: kilka dowodów tej samej zależności to na scenie jeden przewód. */
function homeLinks(edges: RepoGraph["edges"]): HomeLink[] {
  const links = new Map<string, HomeLink>();
  for (const { from, to, kind } of edges) links.set(JSON.stringify([from, to, kind]), { from, to, kind });
  return [...links.values()];
}
