import { describe, expect, test } from "bun:test";
import type { Task, TaskWorkColumn } from "@trackwall/protocol";
import { TaskBoardItem } from "../src/modules/agents/task-board-item.ts";

const ITEM = "7c4d1e2f-0000-4000-8000-000000000000";

function onItem(inReview: boolean): Task {
  return { item: ITEM, inReview } as Task;
}

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("how the work of tasks moves their board item (ADR-213)", () => {
  test("an item goes to review only when every open task on it is in review, and never with no task on it", async () => {
    const moves: [string, TaskWorkColumn][] = [];
    let tasks: Task[] = [onItem(true), onItem(false)];
    const items = new TaskBoardItem({
      move: async (item, column) => {
        moves.push([item, column]);
        return null;
      },
      tasks: () => tasks,
      log: () => {},
    });

    items.handedOver(onItem(true));
    tasks = [onItem(true), onItem(true)];
    items.handedOver(onItem(true));
    tasks = [];
    items.settle(ITEM);
    items.started({ item: null, inReview: false } as Task);
    items.backToWork(onItem(false));
    await settled();

    expect(moves).toEqual([
      [ITEM, "review"],
      [ITEM, "in_progress"],
    ]);
  });

  test("a board that cannot be written is logged, not thrown at the task's start", async () => {
    const logged: string[] = [];
    const items = new TaskBoardItem({
      move: async () => {
        throw new Error("the projects folder is not set");
      },
      tasks: () => [],
      log: (msg) => logged.push(msg),
    });

    items.started(onItem(false));
    await settled();

    expect(logged).toEqual([`board item ${ITEM} did not move to in_progress: the projects folder is not set`]);
  });
});
