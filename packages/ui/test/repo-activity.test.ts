import { describe, expect, test } from "bun:test";
import type { RunningMiseTask, Session, SessionList, Task, TaskProposal, TaskState } from "@trackwall/protocol";
import { repoActivity } from "../src/lib/repo-activity.ts";

const AT = "2026-10-27T10:00:00.000Z";

function session(id: string, repo: string, state: TaskState, more: Partial<Session> = {}): Session {
  return {
    id,
    repo,
    supervisor: false,
    startedAt: AT,
    run: { kind: "running", runId: id, startedAt: AT, pid: 1 },
    state: { state, source: "hook", confidence: "exact", at: AT, reason: "hook agentStop" },
    windowTitle: null,
    needsAttention: state === "Approval",
    task: null,
    dialog: null,
    environment: { variables: [], secrets: [], agentSecrets: [], problem: null },
    ...more,
  };
}

function task(id: string, repo: string, title: string): Task {
  return {
    id,
    repo,
    prompt: title.toLowerCase(),
    branch: `trackwall/${id}`,
    baseBranch: "main",
    base: "a".repeat(40),
    worktree: `/projects/.trackwall-worktrees/${repo}/${id}`,
    createdAt: AT,
    title,
    proposedBy: null,
    model: null,
    summary: null,
    port: 41000,
    included: { files: [], problems: [] },
  };
}

function proposal(id: string, repo: string, title: string): TaskProposal {
  return {
    id,
    kind: "task",
    repo,
    title,
    prompt: title.toLowerCase(),
    proposedBy: { session: null, supervisor: false },
    model: null,
    createdAt: AT,
  };
}

function list(parts: Partial<SessionList>): SessionList {
  return { sessions: [], tasks: [], proposals: [], messages: [], lastSupervisor: null, ...parts };
}

const running = (repo: string, miseTask: string, inTask: string | null = null): RunningMiseTask => ({
  repo,
  task: inTask,
  miseTask,
  run: { kind: "running", runId: miseTask, startedAt: AT, pid: 2 },
});

describe("what is going on in one repo", () => {
  test("proposals come first, then what waits for you, then other sessions and tasks, then running mise tasks", () => {
    const sessions = list({
      sessions: [
        session("s-working", "orders", "Working", { windowTitle: "refactor" }),
        session("s-task", "orders", "Approval", { task: "t-paging" }),
      ],
      tasks: [task("t-paging", "orders", "Add paging")],
      proposals: [proposal("p-rename", "orders", "Rename OrderDto fields")],
    });

    const items = repoActivity("orders", sessions, [running("orders", "test")]);

    expect(items.map((i) => [i.name, i.status.label])).toEqual([
      ["Rename OrderDto fields", "waiting for your decision"],
      ["Add paging", "asking for approval"],
      ["orders · refactor", "working"],
      ["test", "running"],
    ]);
  });

  test("each item opens where its work is: Sessions for proposals, sessions and tasks, the mise tasks tab for the repo root", () => {
    const sessions = list({
      sessions: [session("s-root", "orders", "Working")],
      tasks: [task("t-paging", "orders", "Add paging")],
      proposals: [proposal("p-rename", "orders", "Rename")],
    });

    const items = repoActivity("orders", sessions, [running("orders", "dev"), running("orders", "test", "t-paging")]);

    expect(items.map((i) => i.open)).toEqual([
      { view: "sessions", selection: { kind: "proposal", id: "p-rename" } },
      { view: "sessions", selection: { kind: "session", id: "s-root" } },
      { view: "sessions", selection: { kind: "task", id: "t-paging" } },
      { view: "mise" },
      { view: "sessions", selection: { kind: "task", id: "t-paging" } },
    ]);
    expect(items.at(-1)?.name).toBe("test (in Add paging)");
  });

  test("sessions and tasks that do not wait are listed most recently started first, whatever their kind", () => {
    const sessions = list({
      sessions: [session("s-yesterday", "orders", "Working", { startedAt: "2026-10-26T09:00:00.000Z" })],
      tasks: [{ ...task("t-new", "orders", "New task"), createdAt: "2026-10-27T09:59:00.000Z" }],
    });

    expect(repoActivity("orders", sessions, []).map((i) => i.name)).toEqual(["New task", "orders"]);
  });

  test("other repos, an ended session in the repo root and the supervisor are left out; a task without a session stays", () => {
    const ended = session("s-ended", "orders", "Done", {
      run: { kind: "exited", runId: "s-ended", startedAt: AT, endedAt: AT, exitCode: 0, signal: null, stoppedByUser: false, lastLines: [] },
    });
    const sessions = list({
      sessions: [
        ended,
        session("s-other", "payments", "Working"),
        session("s-super", "orders", "Working", { repo: null, supervisor: true }),
      ],
      tasks: [task("t-old", "orders", "Old task"), task("t-pay", "payments", "Pay")],
      proposals: [proposal("p-pay", "payments", "Pay faster")],
    });

    const items = repoActivity("orders", sessions, [running("payments", "dev")]);

    expect(items.map((i) => [i.name, i.status.label])).toEqual([["Old task", "no session"]]);
  });

  test("before the first session list arrives only running mise tasks show", () => {
    expect(repoActivity("orders", undefined, [running("orders", "dev")]).map((i) => i.name)).toEqual(["dev"]);
  });
});
