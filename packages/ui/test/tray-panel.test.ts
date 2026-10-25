import { expect, test } from "bun:test";
import type { Session, SessionList, TaskProposal } from "@trackwall/protocol";
import { isTrayPanel, trayPanelEntries } from "../src/lib/tray-panel.ts";

const running = { kind: "running", runId: "r", startedAt: "2026-10-24T10:00:00Z", pid: 10 } as const;

function session(id: string, needsAttention: boolean): Session {
  return {
    id,
    repo: `repo-${id}`,
    startedAt: "2026-10-24T10:00:00Z",
    run: running,
    state: null,
    windowTitle: null,
    needsAttention,
    task: null,
  };
}

const proposal: TaskProposal = {
  id: "p1",
  repo: "billing",
  title: "Retry failed invoices",
  prompt: "Retry invoices that failed to send",
  proposedBy: { session: null, supervisor: false },
  createdAt: "2026-10-24T10:00:00Z",
};

test("the tray panel lists the task proposals and only the sessions that wait for you, in list order", () => {
  const list: SessionList = {
    sessions: [session("a", true), session("b", false), session("c", true)],
    tasks: [],
    proposals: [proposal],
    worktreesDir: "worktrees",
  };
  const entries = trayPanelEntries(list);
  expect(entries.proposals).toEqual([proposal]);
  expect(entries.sessions.map((s) => s.id)).toEqual(["a", "c"]);
});

test("the page is the tray panel only with the fragment the shell opens it with", () => {
  expect(isTrayPanel("#tray-panel")).toBe(true);
  expect(isTrayPanel("")).toBe(false);
  expect(isTrayPanel("#token=abc")).toBe(false);
});
