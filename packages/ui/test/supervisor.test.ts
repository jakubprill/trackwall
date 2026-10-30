import { describe, expect, test } from "bun:test";
import type { Session, SessionList, Task, TaskProposal } from "@trackwall/protocol";
import { entryId, proposerLabel, sessionRows } from "../src/lib/session-entries.ts";
import { attentionCount, sessionTitle } from "../src/lib/session-state.ts";
import {
  selectsSupervisor,
  showingTakesKeyboard,
  supervisorChoices,
  supervisorStateLabel,
  supervisorSummary,
} from "../src/lib/supervisor.ts";
import { readSupervisorLayout, saveSupervisorLayout, unfolded, widenedOrNarrowed } from "../src/lib/supervisor-layout.ts";

function session(id: string, repo: string | null, run: Session["run"]["kind"] = "running"): Session {
  const startedAt = "2026-10-25T10:00:00Z";
  return {
    id,
    repo,
    supervisor: repo === null,
    startedAt,
    run:
      run === "exited"
        ? { kind: "exited", runId: id, startedAt, endedAt: startedAt, exitCode: 0, signal: null, stoppedByUser: true, lastLines: [] }
        : { kind: "running", runId: id, startedAt, pid: 1 },
    state: null,
    windowTitle: null,
    needsAttention: false,
    task: null,
    dialog: null,
    environment: { variables: [], secrets: [], agentSecrets: [], profile: null, problem: null },
    view: "terminal",
  };
}

function task(id: string, proposedBy: Task["proposedBy"]): Task {
  return {
    id,
    repo: "shop",
    prompt: "fix the cart",
    branch: `trackwall/fix-${id}`,
    baseBranch: "main",
    base: "a".repeat(40),
    worktree: `/home/me/.trackwall/worktrees/shop/fix-${id}`,
    createdAt: "2026-10-25T10:05:00Z",
    title: "Fix the cart",
    proposedBy,
    model: null,
    approvals: "ask",
    javaNavigation: false,
    item: null,
    view: "terminal",
    summary: null,
    port: 41000,
    included: { files: [], problems: [] },
  };
}

function proposal(id: string, proposedBy: TaskProposal["proposedBy"]): TaskProposal {
  return {
    id,
    kind: "task",
    repo: "billing",
    title: "Add refunds",
    prompt: "add refunds",
    model: null,
    approvals: "ask",
    item: null,
    proposedBy,
    createdAt: "2026-10-25T10:10:00Z",
  };
}

function list(parts: Partial<SessionList>): SessionList {
  return { sessions: [], tasks: [], proposals: [], messages: [], lastSupervisor: null, ...parts };
}

const summary = (data: SessionList) => supervisorSummary(data, sessionRows(data));
const shape = (data: SessionList) => sessionRows(data).map((r) => `${entryId(r.entry)} @${r.depth}${r.supervised ? " supervised" : ""}`);

describe("the supervisor (ADR-58)", () => {
  test("the supervisor is not an entry of the list; its work comes first, one level under its heading", () => {
    const data = list({
      sessions: [session("sup", null), session("s1", "shop")],
      tasks: [task("t1", { session: "sup", supervisor: true }), task("t2", null)],
      proposals: [proposal("p1", { session: "sup", supervisor: true })],
    });
    expect(shape(data)).toEqual(["proposals:sup @1 supervised", "t1 @1 supervised", "t2 @0", "s1 @0"]);
    expect(summary(data)).toMatchObject({ delegated: 2, waitingProposals: 1, sessionWaits: false, waits: true, listed: true });
  });

  test("the supervisor's work stays under its heading after the supervisor session that delegated it is gone", () => {
    const data = list({ tasks: [task("t1", { session: "gone", supervisor: true }), task("t2", { session: "gone", supervisor: false })] });
    expect(shape(data)).toEqual(["t1 @1 supervised", "t2 @0"]);
    expect(summary(data)).toMatchObject({ session: undefined, delegated: 1, waits: false, listed: true });
  });

  test("work a supervised task delegated further sits under that task, still under the supervisor", () => {
    const data = list({
      sessions: [{ ...session("ts1", "shop"), task: "t1" }],
      tasks: [task("t1", { session: "sup", supervisor: true })],
      proposals: [proposal("p1", { session: "ts1", supervisor: false })],
    });
    expect(shape(data)).toEqual(["t1 @1 supervised", "proposals:ts1 @2 supervised"]);
    expect(summary(data)).toMatchObject({ delegated: 1, waitingProposals: 1 });
  });

  test("the panel shows the running supervisor, otherwise the newest that has ended", () => {
    expect(summary(list({ sessions: [session("old", null, "exited"), session("now", null), session("s1", "shop")] })).session?.id).toBe(
      "now",
    );
    expect(summary(list({ sessions: [session("newer", null, "exited"), session("older", null, "exited")] })).session?.id).toBe("newer");
    expect(summary(list({ sessions: [session("s1", "shop")] })).session).toBeUndefined();
    expect(supervisorSummary(undefined, [])).toMatchObject({ session: undefined, listed: false, waits: false });
  });

  test("a selection of the supervisor session goes to its panel, any other selection to Sessions", () => {
    const data = list({ sessions: [session("sup", null), session("s1", "shop")] });
    expect(selectsSupervisor(data, { kind: "session", id: "sup" })).toBe(true);
    expect(selectsSupervisor(data, { kind: "session", id: "s1" })).toBe(false);
    expect(selectsSupervisor(data, { kind: "task", id: "sup" })).toBe(false);
    expect(selectsSupervisor(undefined, { kind: "session", id: "sup" })).toBe(false);
  });

  test("Alt+0 gives the keyboard to the supervisor's terminal, and without a supervisor session leaves it in the view", () => {
    expect(showingTakesKeyboard(summary(list({ sessions: [session("sup", null, "exited")] })))).toBe(true);
    expect(showingTakesKeyboard(summary(list({ sessions: [session("s1", "shop")] })))).toBe(false);
  });

  test("the supervisor waits in its panel, so the Sessions count leaves it out but counts its proposals", () => {
    const data = list({
      sessions: [
        { ...session("sup", null), needsAttention: true },
        { ...session("s1", "shop"), needsAttention: true },
      ],
      proposals: [proposal("p1", { session: "sup", supervisor: true }), proposal("p2", { session: "s1", supervisor: false })],
    });
    expect(attentionCount(data)).toBe(3);
    expect(summary(data)).toMatchObject({ waitingProposals: 1, sessionWaits: true, waits: true });
  });

  test("the supervisor is named Supervisor, and its proposals say they come from it", () => {
    expect(sessionTitle({ ...session("sup", null), windowTitle: "Plan the refunds" })).toBe("Supervisor · Plan the refunds");
    expect(proposerLabel({ session: "sup", supervisor: true }, [])).toBe("proposed by the supervisor");
  });

  test("the panel is pinned until folded or widened, and storage that refuses access reads as pinned", () => {
    const stored = new Map<string, string>();
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    };
    expect(readSupervisorLayout(() => storage)).toBe("pinned");
    saveSupervisorLayout(() => storage, "folded");
    expect(readSupervisorLayout(() => storage)).toBe("folded");
    saveSupervisorLayout(() => storage, "wide");
    expect(readSupervisorLayout(() => storage)).toBe("wide");
    const refusing = () => {
      throw new Error("SecurityError");
    };
    expect(readSupervisorLayout(refusing)).toBe("pinned");
    expect(() => saveSupervisorLayout(refusing, "folded")).not.toThrow();
  });

  test("a panel folded or pinned before it could be widened keeps its layout", () => {
    const storage = (value: string) => () => ({ getItem: () => value });
    expect(readSupervisorLayout(storage("false"))).toBe("folded");
    expect(readSupervisorLayout(storage("true"))).toBe("pinned");
  });

  test("showing the supervisor unfolds a folded panel and keeps a wide one wide", () => {
    expect(unfolded("folded")).toBe("pinned");
    expect(unfolded("pinned")).toBe("pinned");
    expect(unfolded("wide")).toBe("wide");
  });

  test("Widen makes a pinned panel wide, and Narrow pins a wide one again", () => {
    expect(widenedOrNarrowed("pinned")).toBe("wide");
    expect(widenedOrNarrowed("wide")).toBe("pinned");
  });
});

describe("the supervisor's start card (ADR-96, ADR-126)", () => {
  const morning = new Date("2026-10-29T13:00:00.000Z");
  const dayRun = (startedAt: string, supervisor: string | null) => ({
    startedAt,
    finishedAt: startedAt,
    step: "supervisor" as const,
    error: supervisor === null ? "no Copilot CLI in PATH" : null,
    supervisor,
  });
  const titles = (choices: { title: string }[]) => choices.map((c) => c.title);

  test("before today's day start, Start my day comes first, then Continue and New conversation", () => {
    const resumable = summary(list({ sessions: [session("sup", null, "exited")], lastSupervisor: "sup" }));
    const yesterday = dayRun("2026-10-28T12:00:00.000Z", "8a6e0c7e-3b0f-4a43-9d0e-6e7fd0a0c001");

    expect(titles(supervisorChoices(resumable, null, morning))).toEqual([
      "Start my day",
      "Continue the last conversation",
      "New conversation",
    ]);
    expect(titles(supervisorChoices(resumable, yesterday, morning))).toEqual([
      "Start my day",
      "Continue the last conversation",
      "New conversation",
    ]);
  });

  test("once a day start has started the supervisor today, Continue comes first and Start my day says again", () => {
    const resumable = summary(list({ lastSupervisor: "sup" }));
    const today = dayRun("2026-10-29T12:00:00.000Z", "8a6e0c7e-3b0f-4a43-9d0e-6e7fd0a0c001");

    const choices = supervisorChoices(resumable, today, morning);
    expect(titles(choices)).toEqual(["Continue the last conversation", "Start my day again", "New conversation"]);
    expect(choices.map((c) => c.kind)).toEqual(["last", "day", "new"]);
  });

  test("a day start that failed today leaves Start my day first", () => {
    const resumable = summary(list({ lastSupervisor: "sup" }));

    expect(titles(supervisorChoices(resumable, dayRun("2026-10-29T12:00:00.000Z", null), morning))[0]).toBe("Start my day");
  });

  test("without a conversation to go on with, only Start my day and New conversation, also after a day start today", () => {
    const ended = summary(list({ sessions: [session("sup", null, "exited")] }));
    const today = dayRun("2026-10-29T12:00:00.000Z", "8a6e0c7e-3b0f-4a43-9d0e-6e7fd0a0c001");

    expect(titles(supervisorChoices(ended, null, morning))).toEqual(["Start my day", "New conversation"]);
    expect(titles(supervisorChoices(ended, today, morning))).toEqual(["Start my day again", "New conversation"]);
  });
});

describe("the supervisor's state in the panel header (ADR-126)", () => {
  const clock = (iso: string) => iso.slice(11, 16);

  test("says not running without a supervisor, and starting your day while a day start runs", () => {
    expect(supervisorStateLabel(undefined, false, clock)).toEqual({ label: "not running" });
    expect(supervisorStateLabel(undefined, true, clock)).toEqual({ tone: "warning", label: "starting your day…" });
  });

  test("a supervisor you stopped says stopped and when", () => {
    const ended = summary(list({ sessions: [session("sup", null, "exited")] })).session;

    expect(supervisorStateLabel(ended, false, clock)).toEqual({ label: "stopped at 10:00" });
  });
});
