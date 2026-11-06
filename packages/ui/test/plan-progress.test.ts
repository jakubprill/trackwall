import { describe, expect, test } from "bun:test";
import type { BoardItem, Session, Task, TaskOutcome } from "@trackwall/protocol";
import { hiddenAsDone, itemTasks, progressBelow, progressLabel, tasksBelow, tasksWaiting } from "../src/lib/plan-progress.ts";

function item(id: string, fields: Partial<BoardItem> = {}): BoardItem {
  return {
    id,
    kind: "item",
    title: id,
    body: "",
    parent: "p",
    column: "ready",
    order: 1,
    repos: [],
    link: null,
    createdBy: { kind: "user" },
    createdAt: "2026-11-01T09:00:00.000Z",
    updatedAt: "2026-11-01T09:00:00.000Z",
    ...fields,
  };
}

// Fakes with only the fields Plan reads.
function task(id: string, fields: Partial<Task> = {}): Task {
  return {
    id,
    item: null,
    repo: "payments",
    title: id,
    prompt: id,
    createdAt: "2026-11-05T09:00:00.000Z",
    inReview: false,
    ...fields,
  } as Task;
}

function session(id: string, fields: Partial<Session> = {}): Session {
  return {
    id,
    task: null,
    startedAt: "2026-11-05T09:00:00.000Z",
    run: { kind: "running" },
    state: { state: "Working", confidence: "high" },
    needsAttention: false,
    stuck: null,
    ...fields,
  } as Session;
}

// Checkout redesign (p)
//   Pay later (pay): in progress
//     Accept PAY_LATER (accept): in review
//     Retry the call (retry): done
//     Reminder e-mail (remind): dropped
//   Show retries (show): done
//     Old note (note): ready, below a done item
const project = item("p", { kind: "project", parent: null });
const pay = item("pay", { column: "in_progress" });
const accept = item("accept", { parent: "pay", column: "review" });
const retry = item("retry", { parent: "pay", column: "done" });
const remind = item("remind", { parent: "pay", column: "dropped" });
const show = item("show", { column: "done", order: 2 });
const note = item("note", { parent: "show" });
const items = [project, pay, accept, retry, remind, show, note];

const noOutcomes = new Map<string, TaskOutcome>();

describe("how far a project of Plan is and what its tasks do (ADR-215)", () => {
  test("a project counts every item below it by column, and a dropped item is not work to be done", () => {
    const progress = progressBelow(items, "p");
    expect(progress.byColumn).toEqual({ ideas: 0, ready: 1, in_progress: 1, review: 1, done: 2, dropped: 1 });
    expect([progress.done, progress.total]).toEqual([2, 5]);
    expect(progressLabel(progress)).toBe("2 of 5 done");
  });

  test("an item counts only what lies below it, and one with nothing to do has no label", () => {
    expect(progressLabel(progressBelow(items, "pay"))).toBe("1 of 2 done");
    expect(progressLabel(progressBelow(items, "accept"))).toBeUndefined();
  });

  test("an item's tasks come newest first, each with its newest session's state and whether it waits for the user", () => {
    const older = task("older", { item: "accept", createdAt: "2026-11-04T09:00:00.000Z" });
    const newer = task("newer", { item: "accept", inReview: true });
    const sessions = [
      session("first", {
        task: "older",
        startedAt: "2026-11-04T09:00:00.000Z",
        run: { kind: "exited", exitCode: 0, stoppedByUser: true },
      } as Partial<Session>),
      session("second", {
        task: "older",
        startedAt: "2026-11-05T10:00:00.000Z",
        needsAttention: true,
        state: { state: "Input", confidence: "high" },
      } as Partial<Session>),
    ];
    const listed = itemTasks("accept", { tasks: [older, task("other"), newer], sessions, outcomes: noOutcomes });
    expect(listed.map((t) => [t.task.id, t.state.label, t.waitsForYou, t.marks.map((m) => m.label)])).toEqual([
      ["newer", "no session", true, ["In review"]],
      ["older", "waiting for you", true, []],
    ]);
  });

  test("a project counts the tasks on any of its items that wait for the user", () => {
    const tasks = [
      task("a", { item: "accept", inReview: true }),
      task("b", { item: "pay" }),
      task("c", { item: "elsewhere", inReview: true }),
    ];
    expect(tasksWaiting(items, "p", { tasks, sessions: [session("s", { task: "b" })], outcomes: noOutcomes })).toBe(1);
  });

  test("an item's tasks below are those on the items it is split into, at any depth, not its own", () => {
    const tasks = [task("own", { item: "pay" }), task("child", { item: "accept" }), task("elsewhere", { item: "show" })];
    expect(tasksBelow(items, "pay", { tasks, sessions: [], outcomes: noOutcomes }).map((t) => t.task.id)).toEqual(["child"]);
  });

  test("Hide done hides done and dropped items and what lies below them, never the project", () => {
    expect(items.filter((it) => hiddenAsDone(items, it)).map((it) => it.id)).toEqual(["retry", "remind", "show", "note"]);
  });
});
