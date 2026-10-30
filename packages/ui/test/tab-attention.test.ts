import { describe, expect, test } from "bun:test";
import type { Session, SessionList, TaskProposal, TaskState } from "@trackwall/protocol";
import {
  attentionNews,
  attentionSnapshot,
  BURST_MS,
  ProposalBurst,
  sessionNotice,
  tabTitle,
  waitingInTab,
} from "../src/lib/tab-attention.ts";

const running = { kind: "running", runId: "r", startedAt: "2026-10-30T10:00:00Z", pid: 10 } as const;
const exited: Session["run"] = {
  kind: "exited",
  runId: "r",
  startedAt: "2026-10-30T10:00:00Z",
  endedAt: "2026-10-30T10:05:00Z",
  exitCode: 0,
  signal: null,
  stoppedByUser: false,
  lastLines: [],
};

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

  test("counts running sessions waiting for you, the supervisor among them, and every task proposal", () => {
    const waiting = list(
      [
        session("a", "Approval", true),
        session("b", "Working", false),
        session("s", "Input", true, { repo: null, supervisor: true }),
        session("c", "Input", true, { run: exited }),
      ],
      [proposal("p1"), proposal("p2")],
    );
    expect(waitingInTab(waiting)).toBe(4);
    expect(waitingInTab(undefined)).toBe(0);
  });
});

describe("what is new since the previous list", () => {
  test("nothing is new at the first list, also a session already waiting", () => {
    expect(attentionNews(undefined, list([session("a", "Approval", true)], [proposal("p1")]))).toEqual({ sessions: [], proposals: [] });
  });

  test("a session that was working and now waits for you is new, one that waited already or just started is not", () => {
    const before = attentionSnapshot(list([session("a", "Working", false), session("b", "Input", true), session("c", null, false)]));
    const now = list([session("a", "Approval", true), session("b", "Input", true), session("c", "Input", true)]);
    expect(attentionNews(before, now).sessions.map((s) => s.id)).toEqual(["a"]);
  });

  test("a session that stopped responding and then waits is new", () => {
    const before = attentionSnapshot(list([session("a", "Stale", false)]));
    expect(attentionNews(before, list([session("a", "Input", true)])).sessions.map((s) => s.id)).toEqual(["a"]);
  });

  test("a proposal is new unless it was a proposal or a task before, so one that failed to start does not come again", () => {
    const before = attentionSnapshot(list([], [proposal("p1")], ["t1"]));
    const now = list([], [proposal("p1"), proposal("t1"), proposal("p2")]);
    expect(attentionNews(before, now).proposals.map((p) => p.id)).toEqual(["p2"]);
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
  test("names one proposal by its repo and title and opens it", () => {
    const burst = new ProposalBurst();
    expect(burst.add([proposal("p1", "billing")], [proposal("p1", "billing")], 0)).toEqual({
      title: "Task proposal for billing",
      body: "Fix p1",
      tag: "trackwall:proposals:p1",
      target: { kind: "proposal", id: "p1" },
    });
  });

  test("gathers the proposals of one plan under one tag, so each new one replaces the notification with all of them", () => {
    const burst = new ProposalBurst();
    const p1 = proposal("p1", "billing");
    const p2 = proposal("p2", "orders");
    burst.add([p1], [p1], 0);
    expect(burst.add([p2], [p2, p1], 5_000)).toEqual({
      title: "2 task proposals",
      body: "billing: Fix p1\norders: Fix p2",
      tag: "trackwall:proposals:p1",
      target: { kind: "proposal", id: "p1" },
    });
  });

  test("leaves out a proposal of the plan decided in the meantime but keeps the plan's tag", () => {
    const burst = new ProposalBurst();
    burst.add([proposal("p1")], [proposal("p1")], 0);
    const notice = burst.add([proposal("p2")], [proposal("p2")], 5_000);
    expect(notice?.title).toBe("Task proposal for repo-p2");
    expect(notice?.tag).toBe("trackwall:proposals:p1");
  });

  test("starts a new notification for proposals that come long after the last", () => {
    const burst = new ProposalBurst();
    burst.add([proposal("p1")], [proposal("p1")], 0);
    const notice = burst.add([proposal("p2")], [proposal("p2"), proposal("p1")], BURST_MS + 1);
    expect(notice?.title).toBe("Task proposal for repo-p2");
    expect(notice?.tag).toBe("trackwall:proposals:p2");
  });

  test("shows nothing when no proposal is new", () => {
    expect(new ProposalBurst().add([], [proposal("p1")], 0)).toBeUndefined();
  });
});
