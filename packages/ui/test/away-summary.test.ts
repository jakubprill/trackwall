import { describe, expect, test } from "bun:test";
import type { Session, SessionList, Task, TaskProposal } from "@trackwall/protocol";
import { absenceToClose, awayHeadline, awaySummary } from "../src/lib/away-summary.ts";

const away = { from: "2026-10-31T09:00:00.000Z", to: "2026-10-31T11:10:00.000Z" };
const now = new Date("2026-10-31T11:10:00.000Z");
const running = { kind: "running", runId: "r", startedAt: "2026-10-31T08:00:00.000Z", pid: 10 } as const;

function session(id: string, fields: Partial<Session> = {}): Session {
  return {
    id,
    repo: "shop",
    supervisor: false,
    startedAt: "2026-10-31T08:00:00.000Z",
    run: running,
    state: null,
    windowTitle: null,
    needsAttention: false,
    stuck: null,
    task: null,
    dialog: null,
    environment: { variables: [], secrets: [], agentSecrets: [], profile: null, problem: null },
    view: "terminal",
    ...fields,
  };
}

const state = (s: "Working" | "Approval" | "Input" | "Error", at: string) =>
  ({ state: s, source: "hook", confidence: "high", reason: "hook", at }) as const;

function task(id: string, fields: Partial<Task> = {}): Task {
  return {
    id,
    repo: "orders",
    prompt: "Add a price field",
    branch: `trackwall/add-a-price-field-${id}`,
    baseBranch: "main",
    base: "0".repeat(40),
    worktree: `/projects/.trackwall/worktrees/orders/${id}`,
    createdAt: "2026-10-31T08:00:00.000Z",
    title: null,
    proposedBy: null,
    model: null,
    approvals: "ask",
    javaNavigation: false,
    item: null,
    view: "terminal",
    summary: null,
    port: 41000,
    included: { files: [], problems: [] },
    ...fields,
  };
}

const proposal: TaskProposal = {
  id: "p1",
  kind: "task",
  repo: "billing",
  title: "Update the invoice DTO",
  prompt: "…",
  model: null,
  approvals: "ask",
  item: null,
  proposedBy: { session: null, task: null, supervisor: true },
  createdAt: "2026-10-31T10:00:00.000Z",
};

const list = (fields: Partial<SessionList>): SessionList => ({
  sessions: [],
  tasks: [],
  proposals: [],
  messages: [],
  lastSupervisor: null,
  ...fields,
});

describe("While you were away (ADR-151)", () => {
  test("lists what needs you first, then the newest: a proposal, a waiting task, a stuck session and a task that reported its result", () => {
    const items = awaySummary(
      list({
        proposals: [proposal],
        tasks: [
          task("t-waiting"),
          task("t-done", {
            title: "Rename the price field",
            summary: { text: "Renamed it.\nTests pass.", reportedAt: "2026-10-31T10:30:00.000Z" },
          }),
        ],
        sessions: [
          session("s-waiting", { task: "t-waiting", state: state("Approval", "2026-10-31T09:20:00.000Z"), needsAttention: true }),
          session("s-done", { task: "t-done", state: state("Input", "2026-10-31T10:30:00.000Z") }),
          session("s-stuck", {
            repo: "web",
            state: state("Working", "2026-10-31T08:50:00.000Z"),
            stuck: { lastStepAt: "2026-10-31T10:40:00.000Z" },
          }),
        ],
      }),
      away,
      now,
    );

    expect(items).toEqual([
      {
        key: "s-stuck",
        title: "web",
        facts: [{ tone: "warning", text: "may be stuck: no step for 30 min" }],
        at: "2026-10-31T10:40:00.000Z",
        open: { kind: "session", id: "s-stuck" },
      },
      {
        key: "p1",
        title: "billing · Update the invoice DTO",
        facts: [{ tone: "warning", text: "waiting for your decision" }],
        at: "2026-10-31T10:00:00.000Z",
        open: { kind: "proposal", id: "p1" },
      },
      {
        key: "t-waiting",
        title: "orders · Add a price field",
        facts: [{ tone: "warning", text: "asking for approval" }],
        at: "2026-10-31T09:20:00.000Z",
        open: { kind: "task", id: "t-waiting" },
      },
      {
        key: "t-done",
        title: "orders · Rename the price field",
        facts: [{ text: "reported a result: Renamed it." }],
        at: "2026-10-31T10:30:00.000Z",
        open: { kind: "task", id: "t-done" },
      },
    ]);
    expect(awayHeadline(items, away)).toBe("While you were away (2 h 10 min): 4 changes, 3 need you");
  });

  test("leaves out what changed before the absence, work that just goes on, and an end the user caused", () => {
    const stopped: Session["run"] = {
      kind: "exited",
      runId: "r",
      startedAt: "2026-10-31T08:00:00.000Z",
      endedAt: "2026-10-31T10:00:00.000Z",
      exitCode: null,
      signal: "SIGTERM",
      stoppedByUser: true,
      lastLines: [],
    };
    const items = awaySummary(
      list({
        proposals: [{ ...proposal, createdAt: "2026-10-31T08:59:59.000Z" }],
        sessions: [
          session("s-seen", { state: state("Input", "2026-10-31T08:30:00.000Z"), needsAttention: true }),
          session("s-working", { state: state("Working", "2026-10-31T10:00:00.000Z") }),
          session("s-stopped", { run: stopped, state: state("Working", "2026-10-31T09:30:00.000Z") }),
        ],
      }),
      away,
      now,
    );

    expect(items).toEqual([]);
  });

  test("an error and a session that ended on its own while you were away are listed", () => {
    const ended: Session["run"] = {
      kind: "exited",
      runId: "r",
      startedAt: "2026-10-31T08:00:00.000Z",
      endedAt: "2026-10-31T10:05:00.000Z",
      exitCode: 1,
      signal: null,
      stoppedByUser: false,
      lastLines: [],
    };
    const items = awaySummary(
      list({
        sessions: [
          session("s-error", { state: state("Error", "2026-10-31T09:10:00.000Z") }),
          session("s-ended", { repo: "web", run: ended, state: state("Working", "2026-10-31T10:00:00.000Z") }),
        ],
      }),
      away,
      now,
    );

    expect(items.map((i) => [i.key, i.facts])).toEqual([
      ["s-ended", [{ tone: "error", text: "error" }]],
      ["s-error", [{ tone: "error", text: "error" }]],
    ]);
    expect(
      awayHeadline(
        [items[0]].filter((i) => i !== undefined),
        { from: away.from, to: "2026-10-31T09:20:00.000Z" },
      ),
    ).toBe("While you were away (20 min): 1 change, 1 needs you");
  });
});

describe("an absence with nothing to show", () => {
  test("is closed once the list has come, not before", () => {
    expect(absenceToClose(list({}), away, [])).toBe(true);
    expect(absenceToClose(undefined, away, [])).toBe(false);
    expect(absenceToClose(list({ proposals: [proposal] }), away, awaySummary(list({ proposals: [proposal] }), away, now))).toBe(false);
  });
});
