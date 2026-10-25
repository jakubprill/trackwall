import { describe, expect, test } from "bun:test";
import type { GraphEdge, Repo, RepoGraph, Session } from "@trackwall/protocol";
import { daemonAnswered, homeHasObject, homeModel, homeRepoStatus, homeSessionState } from "../src/lib/home-model.ts";

const running = { kind: "running", runId: "r", startedAt: "2026-10-24T10:00:00Z", pid: 10 } as const;

function repo(id: string, status: Partial<{ changes: number; behind: number; unavailable: boolean }> = {}): Repo {
  if (status.unavailable)
    return { id, path: `/p/${id}`, remote: null, status: { kind: "unavailable", message: "git cannot read the repo" } };
  const upstream = status.behind === undefined ? null : { name: "origin/main", ahead: 0, behind: status.behind };
  return {
    id,
    path: `/p/${id}`,
    remote: null,
    status: { kind: "ok", branch: "main", head: null, changes: status.changes ?? 0, untracked: 0, upstream },
  };
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
  return { from, to, kind, key, confidence: "exact", evidence: [{ repo: from, path: "pom.xml", line: 1, detail: "dependency" }] };
}

function graph(edges: GraphEdge[]): RepoGraph {
  return { nodes: [], edges, configProblems: [], configFile: "/home/workspace.yaml" };
}

function exited(exitCode: number, stoppedByUser = false): Session["run"] {
  return { kind: "exited", runId: "r", startedAt: "", endedAt: "", exitCode, signal: null, stoppedByUser, lastLines: [] };
}

describe("migawka pulpitu", () => {
  test("repo state: unavailable, then local changes, then commits to pull, with their count", () => {
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

  test("a repo's layer is its column from the Overview view, and a repo without connections has no layer", () => {
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

  test("several edges of the same pair and kind are one connection; edges to repos outside the list disappear", () => {
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

  test("a running mise task goes to its repo; a session of a repo outside the list does not reach the dashboard", () => {
    const model = homeModel({
      repos: [repo("api")],
      sessions: [session("s1", "api"), session("s2", "gone")],
      graph: undefined,
      running: [{ repo: "api", task: null, miseTask: "dev", run: running }],
      daemonRunning: false,
    });

    expect(model.repos[0]?.runningTask).toBe("dev");
    expect(model.sessions.map((s) => s.id)).toEqual(["s1"]);
    expect(model.daemonRunning).toBe(false);
  });
});

describe("session state on the dashboard", () => {
  test("waiting for you, working and unresponsive", () => {
    expect(homeSessionState(session("s", "a", { needsAttention: true }))).toBe("attention");
    expect(homeSessionState(session("s", "a"))).toBe("working");
    expect(homeSessionState(session("s", "a", { state: { state: "Stale", source: "osc", confidence: "low", at: "", reason: "" } }))).toBe(
      "working",
    );
  });

  test("Input that no longer waits for you is idle", () => {
    expect(homeSessionState(session("s", "a", { state: { state: "Input", source: "hook", confidence: "high", at: "", reason: "" } }))).toBe(
      "idle",
    );
  });

  test("ended with an error or normally; stopped by you counts as ended", () => {
    expect(homeSessionState(session("s", "a", { run: exited(1) }))).toBe("error");
    expect(homeSessionState(session("s", "a", { run: exited(0) }))).toBe("done");
    expect(homeSessionState(session("s", "a", { run: exited(1, true) }))).toBe("done");
  });
});

describe("repo state on the dashboard in words", () => {
  test("number of changes and commits to pull as in the repo list; a repo with commits to pull is not clean", () => {
    const repo = { id: "api", layer: null, runningTask: null };
    expect(homeRepoStatus({ ...repo, state: "changed", count: 1 })).toEqual({ tone: "warning", label: "1 change" });
    expect(homeRepoStatus({ ...repo, state: "behind", count: 1 })).toEqual({ tone: "warning", label: "1 commit to pull" });
    expect(homeRepoStatus({ ...repo, state: "behind", count: 3 })).toEqual({ tone: "warning", label: "3 commits to pull" });
    expect(homeRepoStatus({ ...repo, state: "unavailable", count: 0 })).toEqual({ tone: "error", label: "unavailable" });
    expect(homeRepoStatus({ ...repo, state: "clean", count: 0 })).toEqual({ tone: "ok", label: "clean" });
  });
});

describe("selection and daemon state on the dashboard", () => {
  test("the selection points to an object from the dashboard snapshot; a repo or session that disappeared is not in it", () => {
    const model = homeModel({ repos: [repo("api")], sessions: [session("s1", "api")], graph: undefined, running: [], daemonRunning: true });

    expect(homeHasObject(model, "repo:api")).toBe(true);
    expect(homeHasObject(model, "session:s1")).toBe(true);
    expect(homeHasObject(model, "daemon")).toBe(true);
    expect(homeHasObject(model, "repo:gone")).toBe(false);
    expect(homeHasObject(model, "session:gone")).toBe(false);
  });

  test("the daemon is running while it answers: an error with its code counts, a broken connection and a response outside the contract do not", () => {
    expect(daemonAnswered(undefined, undefined)).toBe(true);
    expect(daemonAnswered("workspace.yaml: bad key", "invalid_config")).toBe(true);
    expect(daemonAnswered("Failed to fetch", undefined)).toBe(false);
    expect(daemonAnswered("unexpected response 502", "bad_response")).toBe(false);
  });
});
