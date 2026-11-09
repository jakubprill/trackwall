import { describe, expect, test } from "bun:test";
import type { Session, Task, TaskProposal } from "@trackwall/protocol";
import {
  entryId,
  entrySelection,
  findEntry,
  proposalKindLabel,
  proposalsName,
  proposerLabel,
  proposerName,
  selectionAfterClose,
  selectionAfterRemoval,
  sessionRows,
  taskTabs,
} from "../src/lib/session-entries.ts";
import { attentionCount } from "../src/lib/session-state.ts";

function session(id: string, startedAt: string, task: string | null = null): Session {
  return {
    id,
    repo: "shop",
    supervisor: false,
    startedAt,
    run: { kind: "running", runId: id, startedAt, pid: 1 },
    state: null,
    windowTitle: null,
    needsAttention: false,
    stuck: null,
    task,
    dialog: null,
    environment: { variables: [], secrets: [], agentSecrets: [], profile: null, problem: null },
    view: "terminal",
    readRequest: null,
    copyRequest: null,
    usage: null,
    model: null,
    modelInUse: null,
    tokenBudget: null,
  };
}

const CHANGE = "9d0c1100-0000-4000-8000-000000000000";

function task(id: string, createdAt: string): Task {
  return {
    id,
    repo: "shop",
    prompt: "fix",
    branch: `trackwall/fix-${id}`,
    baseBranch: "main",
    base: "a".repeat(40),
    worktree: `/home/me/.trackwall/worktrees/shop/fix-${id}`,
    createdAt,
    title: null,
    proposedBy: null,
    model: null,
    approvals: "ask",
    plan: null,
    javaNavigation: false,
    sandbox: false,
    item: null,
    view: "terminal",
    summary: null,
    inReview: false,
    port: 41000,
    included: { files: [], problems: [] },
    change: null,
    retryOf: null,
  };
}

function proposal(id: string, createdAt: string, proposer: string | null = null): TaskProposal {
  return {
    id,
    kind: "task",
    repo: "shop",
    title: "Add a test",
    prompt: "add a test",
    proposedBy: { session: proposer, supervisor: false, task: null },
    model: null,
    approvals: "ask",
    item: null,
    parts: null,
    fromImpact: false,
    createdAt,
  };
}

function delegated(id: string, createdAt: string, proposer: string): Task {
  return { ...task(id, createdAt), title: "Add a test", proposedBy: { session: proposer, supervisor: false, task: null } };
}

/** The entries of the rows, in display order, without depth. */
const rowEntries = (list: Parameters<typeof sessionRows>[0]) => sessionRows(list).map((r) => r.entry);
/** A row as “kind id @depth”, so the shape of the tree is visible on one line. */
const shape = (list: Parameters<typeof sessionRows>[0]) => sessionRows(list).map((r) => `${r.entry.kind} ${entryId(r.entry)} @${r.depth}`);

describe("Sessions view entries", () => {
  test("a task is one entry with its latest session, and the order goes from the most recently started", () => {
    const list = {
      // Newest first, as in `SessionList`.
      sessions: [
        session("s3", "2026-10-23T12:00:00Z", "t1"),
        session("s2", "2026-10-23T11:00:00Z"),
        session("s1", "2026-10-23T10:00:00Z", "t1"),
      ],
      tasks: [task("t2", "2026-10-23T11:30:00Z"), task("t1", "2026-10-23T09:00:00Z")],
      proposals: [],
      messages: [],
      lastSupervisor: null,
      sessionProfile: { name: null },
    };
    expect(rowEntries(list).map((e) => (e.kind === "task" ? `task ${e.task.id} ${e.session?.id}` : `session ${entryId(e)}`))).toEqual([
      "task t1 s3",
      "task t2 undefined",
      "session s2",
    ]);
  });

  test("closing the selected session selects the next entry, and the previous one after the last", () => {
    const entries = rowEntries({
      sessions: [session("s1", "2026-10-23T12:00:00Z"), session("s2", "2026-10-23T11:00:00Z"), session("s3", "2026-10-23T10:00:00Z")],
      tasks: [],
      proposals: [],
      messages: [],
      lastSupervisor: null,
      sessionProfile: { name: null },
    });
    const [s1, s2, s3] = entries;
    if (!s1 || !s2 || !s3) throw new Error("expected three entries");
    expect(selectionAfterClose(entries, { kind: "session", id: "s2" }, s2)).toEqual({ kind: "session", id: "s3" });
    expect(selectionAfterClose(entries, { kind: "session", id: "s3" }, s3)).toEqual({ kind: "session", id: "s2" });
    expect(selectionAfterClose([s1], { kind: "session", id: "s1" }, s1)).toBeUndefined();
  });

  test("closing a session that is not selected, or a task's session, keeps the selection", () => {
    const entries = rowEntries({
      sessions: [session("s1", "2026-10-23T12:00:00Z", "t1"), session("s2", "2026-10-23T11:00:00Z")],
      tasks: [task("t1", "2026-10-23T09:00:00Z")],
      proposals: [],
      messages: [],
      lastSupervisor: null,
      sessionProfile: { name: null },
    });
    const [taskEntry, s2] = entries;
    if (!taskEntry || !s2) throw new Error("expected two entries");
    expect(taskEntry.kind).toBe("task");
    expect(selectionAfterClose(entries, { kind: "task", id: "t1" }, s2)).toBe("keep");
    expect(selectionAfterClose(entries, { kind: "session", id: "s1" }, taskEntry)).toBe("keep");
    expect(selectionAfterClose(entries, undefined, s2)).toBe("keep");
  });

  test("ending the selected task selects its neighbour, and ending another task keeps the selection", () => {
    const entries = rowEntries({
      sessions: [],
      tasks: [task("t1", "2026-10-23T12:00:00Z"), task("t2", "2026-10-23T11:00:00Z")],
      proposals: [],
      messages: [],
      lastSupervisor: null,
      sessionProfile: { name: null },
    });
    const [t1, t2] = entries;
    if (!t1 || !t2) throw new Error("expected two entries");
    expect(selectionAfterRemoval(entries, { kind: "task", id: "t1" }, t1)).toEqual({ kind: "task", id: "t2" });
    expect(selectionAfterRemoval(entries, { kind: "task", id: "t2" }, t2)).toEqual({ kind: "task", id: "t1" });
    expect(selectionAfterRemoval(entries, { kind: "task", id: "t2" }, t1)).toBe("keep");
  });

  test("selecting a task's session (from the tray or “Next waiting”) points to its task", () => {
    const entries = rowEntries({
      sessions: [session("s1", "2026-10-23T12:00:00Z", "t1")],
      tasks: [task("t1", "2026-10-23T09:00:00Z")],
      proposals: [],
      messages: [],
      lastSupervisor: null,
      sessionProfile: { name: null },
    });
    expect(findEntry(entries, { kind: "session", id: "s1" })).toMatchObject({ kind: "task", task: { id: "t1" } });
    expect(findEntry(entries, { kind: "new" })).toBeUndefined();
    expect(findEntry(entries, { kind: "task", id: "unknown" })).toBe(entries[0]);
    expect(findEntry(entries, undefined)).toBe(entries[0]);
  });

  test("selecting from a list entry points to the task, not its session", () => {
    const [entry] = rowEntries({
      sessions: [session("s1", "2026-10-23T12:00:00Z", "t1")],
      tasks: [task("t1", "2026-10-23T09:00:00Z")],
      proposals: [],
      messages: [],
      lastSupervisor: null,
      sessionProfile: { name: null },
    });
    if (!entry) throw new Error("no entry");
    expect(entrySelection(entry)).toEqual({ kind: "task", id: "t1" });
  });

  test("task proposals are at the top, newest first, before sessions and tasks", () => {
    const entries = rowEntries({
      sessions: [session("s1", "2026-10-23T12:00:00Z")],
      tasks: [task("t1", "2026-10-23T13:00:00Z")],
      proposals: [proposal("p2", "2026-10-23T11:00:00Z"), proposal("p1", "2026-10-23T10:00:00Z")],
      messages: [],
      lastSupervisor: null,
      sessionProfile: { name: null },
    });
    expect(entries.map((e) => `${e.kind} ${entryId(e)}`)).toEqual(["proposals proposals:outside", "task t1", "session s1"]);
    expect(findEntry(entries, { kind: "proposal", id: "p1" })).toMatchObject({ kind: "proposals", proposer: null });
  });

  test("proposals of one session are one entry, in the order the session proposed them, and a group of each session", () => {
    const entries = rowEntries({
      sessions: [session("s2", "2026-10-23T09:00:00Z"), session("s1", "2026-10-23T08:00:00Z")],
      tasks: [],
      // Newest first, as the daemon sends them.
      proposals: [
        proposal("p3", "2026-10-23T12:00:00Z", "s2"),
        proposal("p2", "2026-10-23T11:00:00Z", "s1"),
        proposal("p1", "2026-10-23T10:00:00Z", "s1"),
      ],
      messages: [],
      lastSupervisor: null,
      sessionProfile: { name: null },
    });
    expect(entries.map((e) => (e.kind === "proposals" ? `${e.proposer}: ${e.proposals.map((p) => p.id).join(" ")}` : entryId(e)))).toEqual([
      "s2",
      "s2: p3",
      "s1",
      "s1: p1 p2",
    ]);
    const group = entries[3];
    if (!group) throw new Error("no group");
    expect(entrySelection(group)).toEqual({ kind: "proposals", proposer: "s1" });
    expect(findEntry(entries, { kind: "proposals", proposer: "s1" })).toBe(group);
    expect(findEntry(entries, { kind: "proposal", id: "p2" })).toBe(group);
    // A trackwall://task/ link to a proposal.
    expect(findEntry(entries, { kind: "task", id: "p2" })).toBe(group);
  });

  test("a selected proposal that became a task selects that task, not the first entry", () => {
    const entries = rowEntries({
      sessions: [],
      tasks: [task("t0", "2026-10-23T14:00:00Z"), task("p1", "2026-10-23T13:00:00Z")],
      proposals: [],
      messages: [],
      lastSupervisor: null,
      sessionProfile: { name: null },
    });
    expect(findEntry(entries, { kind: "proposal", id: "p1" })).toMatchObject({ kind: "task", task: { id: "p1" } });
  });

  test("the counter on the view bar counts sessions that are waiting and task proposals", () => {
    const waiting = { ...session("s1", "2026-10-23T12:00:00Z"), needsAttention: true };
    const list = {
      sessions: [waiting, session("s2", "2026-10-23T11:00:00Z")],
      tasks: [],
      proposals: [proposal("p1", "2026-10-23T10:00:00Z")],
    };
    expect(attentionCount({ ...list, messages: [], lastSupervisor: null, sessionProfile: { name: null } })).toBe(2);
    expect(attentionCount(undefined)).toBe(0);
  });

  test("tasks and proposals of a main session sit under it, and it knows their count", () => {
    const list = {
      sessions: [session("s2", "2026-10-23T12:00:00Z"), session("s1", "2026-10-23T10:00:00Z")],
      tasks: [delegated("t1", "2026-10-23T11:00:00Z", "s1"), task("t2", "2026-10-23T09:00:00Z")],
      proposals: [proposal("p1", "2026-10-23T11:30:00Z", "s1")],
      messages: [],
      lastSupervisor: null,
      sessionProfile: { name: null },
    };
    expect(shape(list)).toEqual(["session s2 @0", "session s1 @0", "proposals proposals:s1 @1", "task t1 @1", "task t2 @0"]);
    expect(sessionRows(list).find((r) => entryId(r.entry) === "s1")?.children).toBe(2);
  });

  test("a group whose last proposal has just started gives way to the newest task from the same session", () => {
    const entries = rowEntries({
      sessions: [session("s1", "2026-10-23T08:00:00Z")],
      tasks: [delegated("p1", "2026-10-23T12:00:00Z", "s1"), task("t0", "2026-10-23T13:00:00Z")],
      proposals: [],
      messages: [],
      lastSupervisor: null,
      sessionProfile: { name: null },
    });
    expect(findEntry(entries, { kind: "proposals", proposer: "s1" })).toMatchObject({ kind: "task", task: { id: "p1" } });
    expect(findEntry(entries, { kind: "proposals", proposer: "s9" })).toBe(entries[0]);
  });

  test("a gone group of an agent outside Trackwall gives way to its task, not to a task typed in the form", () => {
    const outside: Task = { ...task("p1", "2026-10-23T12:00:00Z"), proposedBy: { session: null, supervisor: false, task: null } };
    const entries = rowEntries({
      sessions: [],
      tasks: [task("t0", "2026-10-23T13:00:00Z"), outside],
      proposals: [],
      messages: [],
      lastSupervisor: null,
      sessionProfile: { name: null },
    });
    expect(findEntry(entries, { kind: "proposals", proposer: null })).toMatchObject({ kind: "task", task: { id: "p1" } });
  });

  test("the main badge counts every proposal of the group under it", () => {
    const list = {
      sessions: [session("s1", "2026-10-23T10:00:00Z")],
      tasks: [delegated("t1", "2026-10-23T11:00:00Z", "s1")],
      proposals: [proposal("p2", "2026-10-23T11:40:00Z", "s1"), proposal("p1", "2026-10-23T11:30:00Z", "s1")],
      messages: [],
      lastSupervisor: null,
      sessionProfile: { name: null },
    };
    expect(sessionRows(list).find((r) => entryId(r.entry) === "s1")?.children).toBe(3);
  });

  test("a task delegated by the session of another task sits under that task, also when it is not its latest session", () => {
    const list = {
      sessions: [session("s2", "2026-10-23T12:00:00Z", "t1"), session("s1", "2026-10-23T10:00:00Z", "t1")],
      tasks: [delegated("t2", "2026-10-23T11:00:00Z", "s1"), task("t1", "2026-10-23T09:00:00Z")],
      proposals: [],
      messages: [],
      lastSupervisor: null,
      sessionProfile: { name: null },
    };
    expect(shape(list)).toEqual(["task t1 @0", "task t2 @1"]);
  });

  test("a task delegated by a task's session stays under that task after the task was resumed in a new session (ADR-140)", () => {
    const list = {
      sessions: [session("s2", "2026-10-23T12:00:00Z", "t1")],
      tasks: [
        { ...delegated("t2", "2026-10-23T11:00:00Z", "s1"), proposedBy: { session: "s1", supervisor: false, task: "t1" } },
        task("t1", "2026-10-23T09:00:00Z"),
      ],
      proposals: [],
      messages: [],
      lastSupervisor: null,
      sessionProfile: { name: null },
    };
    expect(shape(list)).toEqual(["task t1 @0", "task t2 @1"]);
    expect(proposerLabel({ session: "s1", supervisor: false, task: "t1" }, list.sessions)).toBe("proposed by the session in shop");
  });

  test("a task from a session no longer listed and a proposal from an agent outside Trackwall are at the top level", () => {
    const list = {
      sessions: [session("s1", "2026-10-23T10:00:00Z")],
      tasks: [delegated("t1", "2026-10-23T11:00:00Z", "closed")],
      proposals: [proposal("p1", "2026-10-23T09:00:00Z")],
      messages: [],
      lastSupervisor: null,
      sessionProfile: { name: null },
    };
    expect(shape(list)).toEqual(["proposals proposals:outside @0", "task t1 @0", "session s1 @0"]);
  });

  test("the parts of a change sit under its first part in merge order, and under the next one once the first is ended (ADR-171)", () => {
    const part = (id: string, createdAt: string, position: number) => ({ ...task(id, createdAt), change: { id: CHANGE, position } });
    // Started one after another, so the later parts are the newer ones.
    const tasks = [
      part("web", "2026-10-23T10:02:00Z", 2),
      part("orders", "2026-10-23T10:01:00Z", 1),
      task("other", "2026-10-23T10:01:30Z"),
    ];
    const list = (listed: Task[]) => ({
      sessions: [],
      tasks: listed,
      proposals: [],
      messages: [],
      lastSupervisor: null,
      sessionProfile: { name: null },
    });

    expect(shape(list([...tasks, part("payments", "2026-10-23T10:00:00Z", 0)]))).toEqual([
      "task other @0",
      "task payments @0",
      "task orders @1",
      "task web @1",
    ]);
    expect(shape(list(tasks))).toEqual(["task other @0", "task orders @0", "task web @1"]);
  });

  test("tasks that delegate to each other stay on the list instead of looping it", () => {
    const list = {
      sessions: [session("s2", "2026-10-23T12:00:00Z", "t2"), session("s1", "2026-10-23T11:00:00Z", "t1")],
      tasks: [delegated("t2", "2026-10-23T10:00:00Z", "s1"), delegated("t1", "2026-10-23T09:00:00Z", "s2")],
      proposals: [],
      messages: [],
      lastSupervisor: null,
      sessionProfile: { name: null },
    };
    expect(shape(list)).toEqual(["task t2 @0", "task t1 @1"]);
    // t1 delegated t2, but t2 is already above it, so t1 has nothing under it and gets no “main” badge.
    expect(sessionRows(list).map((r) => r.children)).toEqual([1, 0]);
  });

  test("a proposal says whether it came from a session in the list, from a closed session or from an agent outside Trackwall", () => {
    const sessions = [{ ...session("s1", "2026-10-23T12:00:00Z"), windowTitle: "Sprint plan" }];
    expect(proposerLabel({ session: "s1", supervisor: false, task: null }, sessions)).toBe("proposed by the session in shop (Sprint plan)");
    expect(proposerLabel({ session: "s9", supervisor: false, task: null }, sessions)).toBe(
      "proposed by a session that is no longer listed",
    );
    expect(proposerLabel({ session: null, supervisor: false, task: null }, sessions)).toBe("proposed by an agent outside Trackwall");
  });

  test("a task the user handed on from another task's impact says it came from the user and that task (ADR-147)", () => {
    const sessions = [session("s1", "2026-10-23T12:00:00Z", "t1")];
    expect(proposerLabel({ session: null, supervisor: false, task: "t1" }, sessions)).toBe("proposed by you, from the task in shop");
    expect(proposerLabel({ session: null, supervisor: false, task: "t9" }, sessions)).toBe("proposed by you, from another task");
  });

  test("a task message names its sender the same way, the supervisor by its role", () => {
    const sessions = [{ ...session("s1", "2026-10-23T12:00:00Z"), windowTitle: "Sprint plan" }];
    expect(`from ${proposerName({ session: "s1", supervisor: false, task: null }, sessions)}`).toBe(
      "from the session in shop (Sprint plan)",
    );
    expect(`from ${proposerName({ session: "s2", supervisor: true, task: null }, sessions)}`).toBe("from the supervisor");
  });

  test("a free session, which has no repo, is named as a free session (ADR-100)", () => {
    const sessions = [{ ...session("f1", "2026-10-27T12:00:00Z"), repo: null, windowTitle: "API compare" }];
    expect(proposerLabel({ session: "f1", supervisor: false, task: null }, sessions)).toBe("proposed by a free session (API compare)");
  });
});

describe("proposal kinds (ADR-83)", () => {
  test("a single proposal is headed by what it asks for: a task, or removing a repo", () => {
    expect(proposalKindLabel(proposal("p1", "2026-10-26T10:00:00Z"))).toBe("Task proposal");
    expect(proposalKindLabel({ ...proposal("p2", "2026-10-26T10:00:00Z"), kind: "remove_repo" })).toBe("Repo removal");
  });

  test("a group with a repo removal in it is counted as proposals, not as task proposals", () => {
    const task = proposal("p1", "2026-10-26T10:00:00Z");
    const removal: TaskProposal = { ...proposal("p2", "2026-10-26T10:00:00Z"), kind: "remove_repo" };
    expect(proposalsName([task, { ...task, id: "p3" }])).toBe("2 task proposals");
    expect(proposalsName([task, removal])).toBe("2 proposals");
  });

  test("a proposed change is named by its repos in their merge order and its title (ADR-171)", () => {
    const change: TaskProposal = {
      ...proposal("p1", "2026-10-26T10:00:00Z"),
      kind: "change",
      repo: "payments",
      title: "Refund API",
      parts: [
        { repo: "payments", note: "add POST /api/refunds" },
        { repo: "shop-web", note: "" },
      ],
    };
    expect(proposalKindLabel(change)).toBe("Change proposal");
    expect(proposalsName([change])).toBe("payments, shop-web · Refund API");
  });
});

describe("the tabs of a task's panel (ADR-137)", () => {
  test("a task in a terminal has a Terminal tab, one in the conversation view a Chat tab, and one without a session neither", () => {
    expect(taskTabs({ view: "terminal" }).map((t) => t.label)).toEqual(["Terminal", "Shell", "Changes", "Rounds", "Impact", "MCP calls"]);
    expect(taskTabs({ view: "conversation" })[0]).toEqual({ id: "session", label: "Chat" });
    expect(taskTabs(undefined).map((t) => t.label)).toEqual(["Shell", "Changes", "Rounds", "Impact", "MCP calls"]);
  });
});
