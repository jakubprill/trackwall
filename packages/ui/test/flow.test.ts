import { describe, expect, test } from "bun:test";
import type { BoardItem, Session, SessionList, Task, TaskOutcome, TaskProposal } from "@trackwall/protocol";
import { cardsIn, columnCounts, type FlowInput, flowGroups } from "../src/lib/flow.ts";

// Fakes with only the fields Flow reads.
function item(id: string, fields: Partial<BoardItem> = {}): BoardItem {
  return {
    id,
    kind: "item",
    title: id,
    parent: "checkout",
    column: "in_progress",
    order: 1,
    createdAt: "2026-11-01T09:00:00.000Z",
    ...fields,
  } as BoardItem;
}

function task(id: string, fields: Partial<Task> = {}): Task {
  return {
    id,
    repo: "payments",
    title: id,
    prompt: id,
    item: null,
    change: null,
    proposedBy: null,
    inReview: false,
    summary: null,
    createdAt: "2026-11-07T09:00:00.000Z",
    ...fields,
  } as Task;
}

function session(id: string, fields: Partial<Session> = {}): Session {
  return {
    id,
    repo: "payments",
    supervisor: false,
    task: null,
    windowTitle: null,
    startedAt: "2026-11-07T09:00:00.000Z",
    run: { kind: "running" },
    state: { state: "Working", confidence: "high", at: "2026-11-07T10:00:00.000Z" },
    needsAttention: false,
    stuck: null,
    ...fields,
  } as Session;
}

function list(fields: Partial<SessionList>): SessionList {
  return { sessions: [], tasks: [], proposals: [], ...fields } as SessionList;
}

function input(fields: Partial<SessionList>, items: BoardItem[] = [], outcomes = new Map<string, TaskOutcome>()): FlowInput {
  return { list: list(fields), items, outcomes };
}

/** The one card of the only group. */
function onlyCard(flow: FlowInput) {
  const [group] = flowGroups(flow);
  if (group?.cards.length !== 1) throw new Error(`expected one card, got ${JSON.stringify(flowGroups(flow))}`);
  return group.cards[0];
}

describe("the column of a task on the wall (ADR-224)", () => {
  test("a task whose agent is in a turn is working, since the state changed", () => {
    const card = onlyCard(input({ tasks: [task("t")], sessions: [session("s", { task: "t" })] }));
    expect(card).toMatchObject({ column: "working", since: "2026-11-07T10:00:00.000Z", detail: "working", repo: "payments" });
    expect(card?.target).toEqual({ kind: "task", id: "t" });
  });

  test("an approval waits for the user, also when the task is in review", () => {
    const asking = session("s", {
      task: "t",
      needsAttention: true,
      state: { state: "Approval", confidence: "high", at: "2026-11-07T10:05:00.000Z" },
    } as Partial<Session>);
    expect(onlyCard(input({ tasks: [task("t", { inReview: true })], sessions: [asking] }))?.column).toBe("waiting");
  });

  test("a task handed over is in review since its report, even before the user saw the finished turn", () => {
    const finished = session("s", {
      task: "t",
      needsAttention: true,
      state: { state: "Input", confidence: "high", at: "2026-11-07T10:20:00.000Z" },
    } as Partial<Session>);
    const reported = task("t", { inReview: true, summary: { text: "done", checkSteps: [], reportedAt: "2026-11-07T10:19:00.000Z" } });
    expect(onlyCard(input({ tasks: [reported], sessions: [finished] }))).toMatchObject({
      column: "review",
      since: "2026-11-07T10:19:00.000Z",
    });
  });

  test("a finished turn the user has not seen waits for the user", () => {
    const finished = session("s", {
      task: "t",
      needsAttention: true,
      state: { state: "Input", confidence: "high", at: "2026-11-07T10:20:00.000Z" },
    } as Partial<Session>);
    expect(onlyCard(input({ tasks: [task("t")], sessions: [finished] }))?.column).toBe("waiting");
  });

  test("a session with no step for long is stuck since its last step, and one that ended with an error is stuck too", () => {
    const quiet = session("s", { task: "t", stuck: { lastStepAt: "2026-11-07T09:40:00.000Z" } });
    expect(onlyCard(input({ tasks: [task("t")], sessions: [quiet] }))).toMatchObject({
      column: "stuck",
      since: "2026-11-07T09:40:00.000Z",
      detail: "may be stuck",
    });
    const crashed = session("s", { task: "t", run: { kind: "exited", exitCode: 1, stoppedByUser: false } } as Partial<Session>);
    expect(onlyCard(input({ tasks: [task("t")], sessions: [crashed] }))).toMatchObject({ column: "stuck", detail: "error" });
  });

  test("an idle task with a failed verification is stuck with the check named, and without one it is idle", () => {
    const idle = session("s", {
      task: "t",
      state: { state: "Input", confidence: "high", at: "2026-11-07T10:30:00.000Z" },
    } as Partial<Session>);
    const failed = new Map([["t", { task: "t", verification: "failed", verificationOutdated: false, mergeRequest: null } as TaskOutcome]]);
    expect(onlyCard(input({ tasks: [task("t")], sessions: [idle] }, [], failed))).toMatchObject({
      column: "stuck",
      detail: "Verification failed",
    });
    expect(onlyCard(input({ tasks: [task("t")], sessions: [idle] }))).toMatchObject({ column: "idle", detail: "idle" });
  });

  test("a task without a session is idle since it was created", () => {
    expect(onlyCard(input({ tasks: [task("t")] }))).toMatchObject({
      column: "idle",
      since: "2026-11-07T09:00:00.000Z",
      detail: "no session",
    });
  });

  test("a proposal waits for the user's decision since it came, and opens as the task it becomes", () => {
    const proposal = {
      id: "p1",
      title: "Bump Spring Boot",
      repo: "billing",
      item: null,
      proposedBy: { session: "sup", supervisor: true, task: null },
      createdAt: "2026-11-07T10:10:00.000Z",
    } as TaskProposal;
    expect(onlyCard(input({ proposals: [proposal] }))).toMatchObject({
      column: "waiting",
      name: "Bump Spring Boot",
      since: "2026-11-07T10:10:00.000Z",
      detail: "waiting for your decision",
      target: { kind: "task", id: "p1" },
    });
  });
});

describe("the groups on the wall (ADR-224)", () => {
  const checkout = item("checkout", { kind: "project", parent: null, title: "Checkout redesign" });
  const form = item("form", { title: "Split the payment form" });
  const coupons = item("coupons", { column: "done" });
  const items = [checkout, form, coupons];

  test("a task on an item of a project of Plan is in that project's row, with how far the project is", () => {
    const [group] = flowGroups(input({ tasks: [task("t", { item: "form" })] }, items));
    expect(group).toMatchObject({ kind: "project", name: "Checkout redesign", summary: "Plan project · 1 of 2 done" });
  });

  test("the parts of a change share a row named after the first part, with how many repos it spans", () => {
    const change = "c1";
    const parts = [
      task("second", { repo: "web", title: "Rename in web", change: { id: change, position: 1 } }),
      task("first", { repo: "api", title: "Rename customer id", change: { id: change, position: 0 } }),
    ];
    const groups = flowGroups(input({ tasks: parts }));
    expect(groups.map((g) => [g.kind, g.name, g.summary, g.cards.length])).toEqual([
      ["change", "Rename customer id", "Change · 2 repos", 2],
    ]);
  });

  test("the supervisor, its tasks and its proposals share a row, and everything else is in No group", () => {
    const groups = flowGroups(
      input({
        sessions: [session("sup", { supervisor: true, repo: null }), session("free", { repo: null, windowTitle: "Docs" })],
        tasks: [task("fix", { proposedBy: { session: "sup", supervisor: true, task: null } }), task("mine")],
      }),
    );
    expect(groups.map((g) => [g.name, g.cards.map((c) => c.name).sort()])).toEqual([
      ["Supervisor", ["Supervisor", "fix"]],
      ["No group", ["Docs", "mine"]],
    ]);
  });

  test("a session that proposed tasks heads their row, named as in the Sessions list, after the supervisor's row", () => {
    const main = session("main", { repo: "shop-web", windowTitle: "Add a checkout" });
    const proposed = { session: "main", supervisor: false, task: null };
    const groups = flowGroups(
      input({
        sessions: [main, session("sup", { supervisor: true, repo: null })],
        tasks: [task("retry", { proposedBy: proposed })],
        proposals: [
          {
            id: "p1",
            title: "Invoice once",
            repo: "billing",
            item: null,
            proposedBy: proposed,
            createdAt: "2026-11-07T10:00:00.000Z",
          } as TaskProposal,
        ],
      }),
    );
    expect(groups.map((g) => [g.kind, g.name, g.cards.map((c) => c.name).sort()])).toEqual([
      ["supervisor", "Supervisor", ["Supervisor"]],
      ["proposer", "shop-web · Add a checkout", ["Add a checkout", "Invoice once", "retry"]],
    ]);
  });

  test("a task proposed by a task's session stays with that task's later sessions, and work from outside has no group", () => {
    const groups = flowGroups(
      input({
        tasks: [
          task("parent"),
          task("child", { proposedBy: { session: "gone", supervisor: false, task: "parent" } }),
          task("outside", { proposedBy: { session: null, supervisor: false, task: null } }),
        ],
        sessions: [session("later", { task: "parent", windowTitle: "Retry payments" })],
      }),
    );
    expect(groups.map((g) => [g.kind, g.name, g.cards.map((c) => c.name).sort()])).toEqual([
      ["proposer", "payments · Retry payments", ["child"]],
      ["none", "No group", ["outside", "parent"]],
    ]);
  });

  test("a task on an item of a project stays in the project's row when it is also a part of a change", () => {
    const part = task("t", { item: "form", change: { id: "c1", position: 0 } });
    expect(flowGroups(input({ tasks: [part] }, items)).map((g) => g.kind)).toEqual(["project"]);
  });

  test("rows go projects, changes, the supervisor, the rest, and rows of one kind by name", () => {
    const other = item("search", { kind: "project", parent: null, title: "Advanced search" });
    const searchItem = item("filters", { parent: "search" });
    const groups = flowGroups(
      input(
        {
          tasks: [
            task("loose"),
            task("sup", { proposedBy: { session: null, supervisor: true, task: null } }),
            task("part", { change: { id: "c1", position: 0 } }),
            task("pay", { item: "form" }),
            task("find", { item: "filters" }),
          ],
        },
        [...items, other, searchItem],
      ),
    );
    expect(groups.map((g) => g.name)).toEqual(["Advanced search", "Checkout redesign", "part", "Supervisor", "No group"]);
  });

  test("the counts over the wall add up the columns, and a column shows its longest wait first", () => {
    const groups = flowGroups(
      input({
        tasks: [task("a"), task("b"), task("c")],
        sessions: [
          session("sa", { task: "a", state: { state: "Working", confidence: "high", at: "2026-11-07T10:30:00.000Z" } } as Partial<Session>),
          session("sb", { task: "b", state: { state: "Working", confidence: "high", at: "2026-11-07T10:10:00.000Z" } } as Partial<Session>),
        ],
      }),
    );
    expect(columnCounts(groups)).toEqual({ working: 2, waiting: 0, review: 0, stuck: 0, idle: 1 });
    const [group] = groups;
    if (!group) throw new Error("expected a group");
    expect(cardsIn(group, "working").map((c) => c.name)).toEqual(["b", "a"]);
  });
});
