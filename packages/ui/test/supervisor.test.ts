import { describe, expect, test } from "bun:test";
import type { Session, SessionList, Task, TaskProposal } from "@trackwall/protocol";
import { entryId, proposerLabel, sessionRows } from "../src/lib/session-entries.ts";
import { attentionCount, sessionTitle } from "../src/lib/session-state.ts";
import { selectsSupervisor, showingTakesKeyboard, supervisorStarts, supervisorSummary } from "../src/lib/supervisor.ts";
import { readSupervisorPinned, saveSupervisorPinned } from "../src/lib/supervisor-pin.ts";

function session(id: string, repo: string | null, run: Session["run"]["kind"] = "running"): Session {
  const startedAt = "2026-10-25T10:00:00Z";
  return {
    id,
    repo,
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

  test("the panel is pinned until folded, and storage that refuses access reads as pinned", () => {
    const stored = new Map<string, string>();
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    };
    expect(readSupervisorPinned(() => storage)).toBe(true);
    saveSupervisorPinned(() => storage, false);
    expect(readSupervisorPinned(() => storage)).toBe(false);
    const refusing = () => {
      throw new Error("SecurityError");
    };
    expect(readSupervisorPinned(refusing)).toBe(true);
    expect(() => saveSupervisorPinned(refusing, false)).not.toThrow();
  });
});

describe("the supervisor's start buttons (ADR-96)", () => {
  test("while the last supervisor's conversation can go on, the panel offers Resume and New", () => {
    const data = list({ sessions: [session("sup", null, "exited")], lastSupervisor: "sup" });

    expect(supervisorStarts(summary(data)).map((s) => `${s.label} ${s.conversation}`)).toEqual(["Resume last", "New new"]);
  });

  test("Resume is offered also when the daemon no longer lists the last supervisor, after a restart", () => {
    expect(supervisorStarts(summary(list({ lastSupervisor: "sup" }))).map((s) => s.label)).toEqual(["Resume", "New"]);
  });

  test("without a conversation to go on with, one start begins a new one", () => {
    expect(supervisorStarts(summary(list({}))).map((s) => `${s.label} ${s.conversation}`)).toEqual(["Start supervisor new"]);
    expect(supervisorStarts(summary(list({ sessions: [session("sup", null, "exited")] }))).map((s) => s.label)).toEqual(["Start again"]);
  });
});
