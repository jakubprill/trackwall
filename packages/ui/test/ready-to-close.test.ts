import { describe, expect, test } from "bun:test";
import type { Session, Task } from "@trackwall/protocol";
import { closeOutcome, tasksReadyToClose } from "../src/lib/ready-to-close.ts";

// Fakes with only the fields the list reads.
function task(id: string, fields: Partial<Task> = {}): Task {
  return {
    id,
    repo: "shop",
    title: `Task ${id}`,
    prompt: id,
    change: null,
    inReview: true,
    readyToClose: true,
    paused: null,
    summary: { text: "Done.", checkSteps: [], reproTest: null, reportedAt: `2026-11-19T10:0${id}:00.000Z` },
    createdAt: "2026-11-19T09:00:00.000Z",
    ...fields,
  } as Task;
}

function session(task: string, state: "Input" | "Working"): Session {
  return {
    id: `s-${task}`,
    task,
    run: { kind: "running" },
    state: { state, confidence: "high" },
    needsAttention: false,
    stuck: null,
  } as Session;
}

describe("the tasks ready to close on Home (ADR-282)", () => {
  test("lists the tasks whose agent said its work is over and does nothing else, oldest report first", () => {
    const tasks = [
      task("3"),
      task("1"),
      task("2", { readyToClose: false }),
      task("4", { paused: { at: "2026-11-19T11:00:00.000Z", service: null } }),
      task("5"),
    ];
    const sessions = [session("3", "Input"), session("5", "Working")];

    expect(tasksReadyToClose(tasks, sessions).map((t) => t.id)).toEqual(["1", "3"]);
  });

  test("puts the lead part of a change with one session after the parts it works on, which the daemon ends first (ADR-265)", () => {
    const change = (session: string) => ({ id: "c", position: 1, session }) as Task["change"];
    const tasks = [task("1", { change: change("1") }), task("2", { change: change("1") }), task("3", { change: change("1") })];

    expect(tasksReadyToClose(tasks, []).map((t) => t.id)).toEqual(["2", "3", "1"]);
  });

  test("Close all says how many it closed, and names each task it left open with the daemon's reason", () => {
    expect(closeOutcome([{ task: task("1") }, { task: task("2") }])).toBe("Closed 2 tasks.");
    expect(
      closeOutcome([
        { task: task("1") },
        { task: task("2"), refused: "ending the task would delete: uncommitted changes in the worktree (3)" },
      ]),
    ).toBe("Closed 1 task. Still open, 1 task: shop · Task 2: ending the task would delete: uncommitted changes in the worktree (3).");
  });
});
