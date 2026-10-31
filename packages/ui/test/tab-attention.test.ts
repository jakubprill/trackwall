import { describe, expect, test } from "bun:test";
import type { Session, SessionList, TaskProposal, TaskState } from "@trackwall/protocol";
import { BURST_MS, sessionNotice, TabAttention, tabTitle } from "../src/lib/tab-attention.ts";

const running = { kind: "running", runId: "r", startedAt: "2026-10-30T10:00:00Z", pid: 10 } as const;

function session(id: string, state: TaskState | null, needsAttention: boolean, extra: Partial<Session> = {}): Session {
  return {
    id,
    repo: `repo-${id}`,
    supervisor: false,
    startedAt: "2026-10-30T10:00:00Z",
    run: running,
    state: state && { state, source: "hook", confidence: "high", at: "2026-10-30T10:01:00Z", reason: "hook" },
    windowTitle: null,
    needsAttention,
    stuck: null,
    task: null,
    dialog: null,
    environment: { variables: [], secrets: [], agentSecrets: [], profile: null, problem: null },
    view: "terminal",
    ...extra,
  };
}

function proposal(id: string, repo = `repo-${id}`): TaskProposal {
  return {
    id,
    kind: "task",
    repo,
    title: `Fix ${id}`,
    prompt: "p",
    proposedBy: { session: null, supervisor: false, task: null },
    model: null,
    approvals: "ask",
    item: null,
    createdAt: "2026-10-30T10:00:00Z",
  };
}

function list(sessions: Session[], proposals: TaskProposal[] = [], taskIds: string[] = []): SessionList {
  return {
    sessions,
    tasks: taskIds.map((id) => ({ id }) as SessionList["tasks"][number]),
    proposals,
    messages: [],
    lastSupervisor: null,
  };
}

describe("the tab title", () => {
  test("is the app's name when nothing waits and the count in front of it when something does", () => {
    expect(tabTitle(0)).toBe("Trackwall");
    expect(tabTitle(3)).toBe("(3) Trackwall");
  });

  test("shows the count also at the first list and while the tab is in front", () => {
    const tab = new TabAttention();
    expect(tab.next(list([session("a", "Approval", true)]), 0, true).title).toBe("(1) Trackwall");
  });
});

describe("the notifications after each list", () => {
  test("none at the first list, also for a session already waiting and a proposal", () => {
    const tab = new TabAttention();
    expect(tab.next(list([session("a", "Approval", true)], [proposal("p1")]), 0, false).notices).toEqual([]);
  });

  test("a session that was working and now waits is announced, one that waited already or just started is not", () => {
    const tab = new TabAttention();
    tab.next(list([session("a", "Working", false), session("b", "Input", true), session("c", null, false)]), 0, false);
    const { notices } = tab.next(
      list([session("a", "Approval", true), session("b", "Input", true), session("c", "Input", true)]),
      1,
      false,
    );
    expect(notices.map((n) => n.target)).toEqual([{ kind: "session", id: "a" }]);
  });

  test("a session that stopped responding and then waits is announced", () => {
    const tab = new TabAttention();
    tab.next(list([session("a", "Stale", false)]), 0, false);
    expect(tab.next(list([session("a", "Input", true)]), 1, false).notices).toHaveLength(1);
  });

  test("nothing is announced while the tab is in front, and the wait seen there is not announced later", () => {
    const tab = new TabAttention();
    tab.next(list([session("a", "Working", false)]), 0, false);
    expect(tab.next(list([session("a", "Approval", true)]), 1, true).notices).toEqual([]);
    expect(tab.next(list([session("a", "Approval", true)]), 2, false).notices).toEqual([]);
  });

  test("a proposal is new unless it was a proposal or a task before, so one that failed to start does not come again", () => {
    const tab = new TabAttention();
    tab.next(list([], [proposal("p1")], ["t1"]), 0, false);
    const { notices } = tab.next(list([], [proposal("p1"), proposal("t1"), proposal("p2")]), 1, false);
    expect(notices.map((n) => n.target)).toEqual([{ kind: "proposal", id: "p2" }]);
  });

  test("sessions come before the proposals", () => {
    const tab = new TabAttention();
    tab.next(list([session("a", "Working", false)]), 0, false);
    const { notices } = tab.next(list([session("a", "Input", true)], [proposal("p1")]), 1, false);
    expect(notices.map((n) => n.target.kind)).toEqual(["session", "proposal"]);
  });
});

describe("a session's notification", () => {
  test("says where the session works and what it waits for, in the words of the session states", () => {
    expect(sessionNotice(session("a", "Approval", true, { repo: "orders-api" }))).toEqual({
      title: "Session in orders-api",
      body: "Copilot CLI is asking for approval",
      tag: "trackwall:session:a",
      target: { kind: "session", id: "a" },
    });
    expect(sessionNotice(session("b", "Plan", true)).body).toBe("Copilot CLI is waiting for plan approval");
    expect(sessionNotice(session("c", "Input", true)).body).toBe("Copilot CLI is waiting for you");
  });

  test("names the supervisor and a free session by their place", () => {
    expect(sessionNotice(session("s", "Input", true, { repo: null, supervisor: true })).title).toBe("Supervisor");
    expect(sessionNotice(session("f", "Input", true, { repo: null })).title).toBe("Free session");
  });
});

describe("the notification of task proposals", () => {
  /** A tab that has seen an empty list, so the next proposals are new. */
  function tabAfterEmptyList(): TabAttention {
    const tab = new TabAttention();
    tab.next(list([]), 0, false);
    return tab;
  }

  test("names one proposal by its repo and title and opens it", () => {
    const tab = tabAfterEmptyList();
    expect(tab.next(list([], [proposal("p1", "billing")]), 1, false).notices).toEqual([
      { title: "Task proposal for billing", body: "Fix p1", tag: "trackwall:proposals:p1", target: { kind: "proposal", id: "p1" } },
    ]);
  });

  test("gathers the proposals of one plan under one tag, so each new one replaces the notification with all of them", () => {
    const tab = tabAfterEmptyList();
    const p1 = proposal("p1", "billing");
    const p2 = proposal("p2", "orders");
    tab.next(list([], [p1]), 1, false);
    expect(tab.next(list([], [p2, p1]), 5_000, false).notices).toEqual([
      {
        title: "2 task proposals",
        body: "billing: Fix p1\norders: Fix p2",
        tag: "trackwall:proposals:p1",
        target: { kind: "proposal", id: "p1" },
      },
    ]);
  });

  test("leaves out a proposal of the plan decided in the meantime but keeps the plan's tag", () => {
    const tab = tabAfterEmptyList();
    tab.next(list([], [proposal("p1")]), 1, false);
    const [notice] = tab.next(list([], [proposal("p2")], ["p1"]), 5_000, false).notices;
    expect(notice?.title).toBe("Task proposal for repo-p2");
    expect(notice?.tag).toBe("trackwall:proposals:p1");
  });

  test("does not name proposals that came while the tab was in front", () => {
    const tab = tabAfterEmptyList();
    tab.next(list([], [proposal("p1")]), 1, true);
    const [notice] = tab.next(list([], [proposal("p2"), proposal("p1")]), 5_000, false).notices;
    expect(notice?.title).toBe("Task proposal for repo-p2");
    expect(notice?.tag).toBe("trackwall:proposals:p2");
  });

  test("starts a new notification for proposals that come long after the last", () => {
    const tab = tabAfterEmptyList();
    tab.next(list([], [proposal("p1")]), 1, false);
    const [notice] = tab.next(list([], [proposal("p2"), proposal("p1")]), 1 + BURST_MS + 1, false).notices;
    expect(notice?.title).toBe("Task proposal for repo-p2");
    expect(notice?.tag).toBe("trackwall:proposals:p2");
  });
});
