import { describe, expect, test } from "bun:test";
import type { RepoStatus, RunningMiseTask, Session, SessionList, Task, TaskProposal } from "@trackwall/protocol";
import { notOnServer, removalBlockers, removalConfirmed } from "../src/lib/repo-removal.ts";

const AT = "2026-11-25T10:00:00.000Z";
const HEAD = { hash: "a".repeat(40), subject: "Start", author: "Demo", date: AT };

// Fakes with only the fields the removal panel reads; the rest of a session, task and proposal does not matter here.
const session = (id: string, repo: string, exited = false) =>
  ({
    id,
    repo,
    task: null,
    startedAt: AT,
    run: exited
      ? { kind: "exited", runId: id, startedAt: AT, endedAt: AT, code: 0 }
      : { kind: "running", runId: id, startedAt: AT, pid: 1 },
    state: null,
    needsAttention: false,
    windowTitle: null,
  }) as unknown as Session;
const task = (id: string, repo: string) => ({ id, repo, title: `Task ${id}`, createdAt: AT, paused: null }) as unknown as Task;
const proposal = (id: string, repo: string) =>
  ({ id, kind: "task", repo, title: `Proposal ${id}`, parts: null, createdAt: AT }) as unknown as TaskProposal;
const list = (parts: Partial<SessionList>) =>
  ({ sessions: [], tasks: [], proposals: [], messages: [], lastSupervisor: null, ...parts }) as unknown as SessionList;
const running = (repo: string, miseTask: string): RunningMiseTask => ({
  repo,
  task: null,
  miseTask,
  run: { kind: "running", runId: miseTask, startedAt: AT, pid: 2 },
});
const ok = (more: Partial<Extract<RepoStatus, { kind: "ok" }>>): RepoStatus => ({
  kind: "ok",
  branch: "main",
  head: HEAD,
  changes: 0,
  untracked: 0,
  upstream: { name: "origin/main", ahead: 0, behind: 0 },
  fetchedAt: null,
  ...more,
});

describe("what keeps a repo from being removed", () => {
  test("a running session in the repo root, a task of the repo and a running mise task block it; proposals do not", () => {
    const sessions = list({
      sessions: [session("s1", "orders"), session("s2", "orders", true), session("s3", "shop")],
      tasks: [task("t1", "orders"), task("t2", "shop")],
      proposals: [proposal("p1", "orders")],
    });

    const keys = removalBlockers("orders", sessions, [running("orders", "dev"), running("shop", "dev")]).map((b) => b.key);

    expect(keys.sort()).toEqual(["mise:root:dev", "session:s1", "task:t1"]);
  });

  test("a repo with nothing running in it has no blockers", () => {
    expect(removalBlockers("orders", list({ proposals: [proposal("p1", "orders")] }), [])).toEqual([]);
  });
});

describe("the typed name confirms the removal", () => {
  test("only the repo's name exactly, as on GitHub", () => {
    expect(removalConfirmed("orders-api", "orders-api")).toBe(true);
    expect(removalConfirmed("", "orders-api")).toBe(false);
    expect(removalConfirmed("orders", "orders-api")).toBe(false);
    expect(removalConfirmed("Orders-api", "orders-api")).toBe(false);
    expect(removalConfirmed(" orders-api", "orders-api")).toBe(false);
    expect(removalConfirmed("orders-api ", "orders-api")).toBe(false);
  });
});

describe("what the folder takes along that is not on the server", () => {
  test("changed and new files and commits not pushed, counted", () => {
    expect(notOnServer(ok({ changes: 2, untracked: 1, upstream: { name: "origin/main", ahead: 2, behind: 0 } }))).toBe(
      "It takes along what is not on the server: 1 changed file, 1 new file, 2 commits not pushed.",
    );
  });

  test("a branch with no upstream is named, since none of its commits may be on a server", () => {
    expect(notOnServer(ok({ upstream: null }))).toBe("It takes along what is not on the server: a branch with no upstream.");
  });

  test("a clean repo in step with its upstream, and a repo whose status is not known, say nothing", () => {
    expect(notOnServer(ok({}))).toBeNull();
    expect(notOnServer({ kind: "loading" })).toBeNull();
    expect(notOnServer({ kind: "unavailable", message: "no git" })).toBeNull();
  });
});
