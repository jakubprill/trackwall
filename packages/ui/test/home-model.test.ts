import { describe, expect, test } from "bun:test";
import type { GraphEdge, Repo, RepoGraph, Session } from "@trackwall/protocol";
import { homeModel, homeRepoStateText, homeSessionState } from "../src/lib/home-model.ts";

const running = { kind: "running", runId: "r", startedAt: "2026-10-24T10:00:00Z", pid: 10 } as const;

function repo(id: string, status: Partial<{ changes: number; behind: number; unavailable: boolean }> = {}): Repo {
  if (status.unavailable) return { id, path: `/p/${id}`, remote: null, status: { kind: "unavailable", message: "git nie czyta repo" } };
  const upstream = status.behind === undefined ? null : { name: "origin/main", ahead: 0, behind: status.behind };
  return { id, path: `/p/${id}`, remote: null, status: { kind: "ok", branch: "main", head: null, changes: status.changes ?? 0, upstream } };
}

function session(id: string, repoId: string, over: Partial<Session> = {}): Session {
  return {
    id,
    repo: repoId,
    startedAt: "2026-10-24T10:00:00Z",
    run: running,
    state: { state: "Working", source: "hook", confidence: "high", at: "2026-10-24T10:01:00Z", reason: "hook" },
    windowTitle: null,
    needsAttention: false,
    task: null,
    ...over,
  };
}

function edge(from: string, to: string, kind: GraphEdge["kind"], key = "k"): GraphEdge {
  return { from, to, kind, key, confidence: "exact", evidence: [{ repo: from, path: "pom.xml", line: 1, detail: "zależność" }] };
}

function graph(edges: GraphEdge[]): RepoGraph {
  return { nodes: [], edges, configProblems: [], configFile: "/home/workspace.yaml" };
}

function exited(exitCode: number, stoppedByUser = false): Session["run"] {
  return { kind: "exited", runId: "r", startedAt: "", endedAt: "", exitCode, signal: null, stoppedByUser, lastLines: [] };
}

describe("migawka pulpitu", () => {
  test("stan repo: niedostępne, potem lokalne zmiany, potem commity do pobrania, z ich liczbą", () => {
    const model = homeModel({
      repos: [repo("a", { unavailable: true }), repo("b", { changes: 3, behind: 2 }), repo("c", { behind: 2 }), repo("d", { behind: 0 })],
      sessions: [],
      graph: undefined,
      running: [],
      daemonRunning: true,
    });

    expect(model.repos.map((r) => [r.id, r.state, r.count])).toEqual([
      ["a", "unavailable", 0],
      ["b", "changed", 3],
      ["c", "behind", 2],
      ["d", "clean", 0],
    ]);
  });

  test("warstwa repo to kolumna z widoku Overview, a repo bez połączeń nie ma warstwy", () => {
    const model = homeModel({
      repos: [repo("web"), repo("api"), repo("lib"), repo("docs")],
      sessions: [],
      graph: graph([edge("web", "api", "http"), edge("api", "lib", "package"), edge("web", "lib", "package")]),
      running: [],
      daemonRunning: true,
    });

    expect(model.layerCount).toBe(3);
    expect(model.repos.map((r) => [r.id, r.layer])).toEqual([
      ["web", 0],
      ["api", 1],
      ["lib", 2],
      ["docs", null],
    ]);
  });

  test("kilka krawędzi tej samej pary i rodzaju to jedno połączenie; krawędzie do repo spoza listy znikają", () => {
    const model = homeModel({
      repos: [repo("web"), repo("api")],
      sessions: [],
      graph: graph([
        edge("web", "api", "http", "orders"),
        edge("web", "api", "http", "users"),
        edge("web", "api", "package"),
        edge("web", "gone", "http"),
      ]),
      running: [],
      daemonRunning: true,
    });

    expect(model.links).toEqual([
      { from: "web", to: "api", kind: "http" },
      { from: "web", to: "api", kind: "package" },
    ]);
  });

  test("działający task mise trafia do swojego repo; sesja repo spoza listy nie trafia na pulpit", () => {
    const model = homeModel({
      repos: [repo("api")],
      sessions: [session("s1", "api"), session("s2", "gone")],
      graph: undefined,
      running: [{ repo: "api", miseTask: "dev", run: running }],
      daemonRunning: false,
    });

    expect(model.repos[0]?.runningTask).toBe("dev");
    expect(model.sessions.map((s) => s.id)).toEqual(["s1"]);
    expect(model.daemonRunning).toBe(false);
  });
});

describe("stan sesji na pulpicie", () => {
  test("czekająca na Ciebie, pracująca i niereagująca", () => {
    expect(homeSessionState(session("s", "a", { needsAttention: true }))).toBe("attention");
    expect(homeSessionState(session("s", "a"))).toBe("working");
    expect(homeSessionState(session("s", "a", { state: { state: "Stale", source: "osc", confidence: "low", at: "", reason: "" } }))).toBe(
      "working",
    );
  });

  test("zakończona błędem albo zwykle; zatrzymana przez Ciebie to zakończona", () => {
    expect(homeSessionState(session("s", "a", { run: exited(1) }))).toBe("error");
    expect(homeSessionState(session("s", "a", { run: exited(0) }))).toBe("done");
    expect(homeSessionState(session("s", "a", { run: exited(1, true) }))).toBe("done");
  });
});

describe("stan repo na pulpicie słowami", () => {
  test("liczba zmian i commitów do pobrania jak na liście repo", () => {
    const repo = { id: "api", layer: null, runningTask: null };
    expect(homeRepoStateText({ ...repo, state: "changed", count: 1 })).toBe("1 change");
    expect(homeRepoStateText({ ...repo, state: "behind", count: 3 })).toBe("3 commits to pull");
    expect(homeRepoStateText({ ...repo, state: "unavailable", count: 0 })).toBe("unavailable");
    expect(homeRepoStateText({ ...repo, state: "clean", count: 0 })).toBe("clean");
  });
});
