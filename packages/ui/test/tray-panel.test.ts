import { expect, test } from "bun:test";
import type { Session, SessionList, TaskProposal } from "@trackwall/protocol";
import { isTrayPanel, trayPanelEntries } from "../src/lib/tray-panel.ts";

const running = { kind: "running", runId: "r", startedAt: "2026-10-24T10:00:00Z", pid: 10 } as const;

function session(id: string, needsAttention: boolean, dialog: Session["dialog"] = null): Session {
  return {
    id,
    repo: `repo-${id}`,
    supervisor: false,
    startedAt: "2026-10-24T10:00:00Z",
    run: running,
    state: null,
    windowTitle: null,
    needsAttention,
    task: null,
    dialog,
    environment: { variables: [], secrets: [], agentSecrets: [], problem: null },
    view: "terminal",
  };
}

const proposal: TaskProposal = {
  id: "p1",
  kind: "task",
  repo: "billing",
  title: "Retry failed invoices",
  prompt: "Retry invoices that failed to send",
  proposedBy: { session: null, supervisor: false },
  model: null,
  approvals: "ask",
  createdAt: "2026-10-24T10:00:00Z",
};

test("the tray panel lists the task proposals and only the sessions that wait for you, in list order", () => {
  const list: SessionList = {
    sessions: [session("a", true), session("b", false), session("c", true)],
    tasks: [],
    proposals: [proposal],
    messages: [],
    lastSupervisor: null,
  };
  const entries = trayPanelEntries(list);
  expect(entries.proposals).toEqual([proposal]);
  expect(entries.sessions.map((s) => s.id)).toEqual(["a", "c"]);
});

test("sessions asking for approval come first, apart from the other waiting sessions, because the panel answers them", () => {
  const approval = {
    id: "d1",
    kind: "approval" as const,
    title: "Run the tests",
    detail: ["mvn -q test"],
    question: "Do you want to run this command?",
    options: [{ key: "1", label: "Yes" }],
  };
  const question = { ...approval, kind: "question" as const, options: [] };
  const list: SessionList = {
    sessions: [session("a", true, question), session("b", true, approval), session("c", true)],
    tasks: [],
    proposals: [proposal],
    messages: [],
    lastSupervisor: null,
  };
  const entries = trayPanelEntries(list);
  expect(entries.approvals.map((s) => s.id)).toEqual(["b"]);
  expect(entries.sessions.map((s) => s.id)).toEqual(["a", "c"]);
});

test("the page is the tray panel only with the fragment the shell opens it with", () => {
  expect(isTrayPanel("#tray-panel")).toBe(true);
  expect(isTrayPanel("")).toBe(false);
  expect(isTrayPanel("#token=abc")).toBe(false);
});
