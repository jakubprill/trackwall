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
import { changesLabel } from "./format.ts";
import { layoutGraph } from "./graph-layout.ts";
import type { StatusTone } from "./repo-status.ts";
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

/**
 * Niedostępne, potem zmiany w katalogu roboczym (jak `repoStatusTone` na liście repo), potem commity do pobrania,
 * których lista repo nie liczy do stanu, a pulpit tak, bo to też praca do zrobienia.
 */
function repoState(repo: Repo): { state: HomeRepoState; count: number } {
  const { status } = repo;
  if (status.kind !== "ok") return { state: "unavailable", count: 0 };
  if (status.changes > 0) return { state: "changed", count: status.changes };
  const behind = status.upstream?.behind ?? 0;
  return behind > 0 ? { state: "behind", count: behind } : { state: "clean", count: 0 };
}

/** Stan obiektu pulpitu w jednej linii: ton kropki i tekst. Jedno miejsce dla kolejki, szczegółów, podglądu i etykiet. */
export interface HomeStatus {
  tone?: StatusTone;
  label: string;
}

const REPO_TONES: Record<HomeRepoState, StatusTone> = { clean: "ok", behind: "warning", changed: "warning", unavailable: "error" };

/** Stan repo z pulpitu tymi samymi słowami co lista repo, a przy repo do pobrania z liczbą commitów. */
export function homeRepoStatus(repo: HomeRepo): HomeStatus {
  const tone = REPO_TONES[repo.state];
  if (repo.state === "changed") return { tone, label: changesLabel(repo.count) ?? "changed" };
  if (repo.state === "behind") return { tone, label: `${countLabel(repo.count, { one: "commit", other: "commits" })} to pull` };
  return { tone, label: repo.state };
}

/** Słowa jak w widoku „Sessions” (`sessionStateLabel`), bez „prawdopodobnie”, bo pulpit pokazuje tylko kategorię. */
export const HOME_SESSION_STATUS: Record<HomeSessionState, HomeStatus> = {
  working: { tone: "ok", label: "working" },
  attention: { tone: "warning", label: "waiting for you" },
  error: { tone: "error", label: "error" },
  done: { label: "finished" },
};

export function homeDaemonStatus(running: boolean): HomeStatus {
  return running ? { tone: "ok", label: "daemon running" } : { tone: "error", label: "daemon not responding" };
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

/** Obiekt pod kluczem jest w migawce; wybór obiektu, który zniknął (zakończona sesja, usunięte repo), przepada. */
export function homeHasObject(model: HomeModel, key: HomeKey): boolean {
  const target = parseHomeKey(key);
  if (target?.kind === "repo") return model.repos.some((r) => r.id === target.id);
  if (target?.kind === "session") return model.sessions.some((s) => s.id === target.id);
  return target?.kind === "daemon";
}

/** Jedno połączenie na parę repo i rodzaj: kilka dowodów tej samej zależności to na scenie jeden przewód. */
function homeLinks(edges: RepoGraph["edges"]): HomeLink[] {
  const links = new Map<string, HomeLink>();
  for (const { from, to, kind } of edges) links.set(JSON.stringify([from, to, kind]), { from, to, kind });
  return [...links.values()];
}
