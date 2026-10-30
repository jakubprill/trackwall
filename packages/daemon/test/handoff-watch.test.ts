import { describe, expect, test } from "bun:test";
import { type HandoffTasks, HandoffWatch } from "../src/modules/agents/handoff-watch.ts";

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("asking a subtask to read get_handoff (ADR-144)", () => {
  test("a handing task's turn end marks each subtask whose handing branch moved and asks its session once", async () => {
    const asked: string[] = [];
    const tasks: HandoffTasks = {
      handedTo: () => ["moved", "same"],
      handoffMoved: async (task) => task === "moved",
      readHandoff: async () => null,
    };
    const watch = new HandoffWatch(
      tasks,
      (task) => asked.push(task),
      () => {},
    );
    await watch.turnOver("parent");
    await watch.turnOver("parent");
    expect(asked).toEqual(["moved"]);
    expect(watch.waiting("moved")).toBe(true);
    expect(watch.waiting("same")).toBe(false);
  });

  test("a read ends the wait, and a check that compared before the read does not mark the task again", async () => {
    const moved = deferred<boolean>();
    const asked: string[] = [];
    const tasks: HandoffTasks = { handedTo: () => ["child"], handoffMoved: () => moved.promise, readHandoff: async () => null };
    const watch = new HandoffWatch(
      tasks,
      (task) => asked.push(task),
      () => {},
    );
    const check = watch.check("child");
    await watch.read("child");
    moved.resolve(true);
    await check;
    expect(watch.waiting("child")).toBe(false);
    expect(asked).toEqual([]);
  });

  test("a failed read keeps the wait, so the subtask is asked again", async () => {
    const tasks: HandoffTasks = {
      handedTo: () => ["child"],
      handoffMoved: async () => true,
      readHandoff: () => Promise.reject(new Error("git is gone")),
    };
    const watch = new HandoffWatch(
      tasks,
      () => {},
      () => {},
    );
    await watch.check("child");
    await expect(watch.read("child")).rejects.toThrow("git is gone");
    expect(watch.waiting("child")).toBe(true);
  });

  test("a failed git check is logged and marks nothing", async () => {
    const log: string[] = [];
    const tasks: HandoffTasks = {
      handedTo: () => ["child"],
      handoffMoved: () => Promise.reject(new Error("no worktree")),
      readHandoff: async () => null,
    };
    const watch = new HandoffWatch(
      tasks,
      () => {},
      (message) => log.push(message),
    );
    await watch.turnOver("parent");
    expect(watch.waiting("child")).toBe(false);
    expect(log).toEqual(["task child: checking the branch of the task that handed it its work: no worktree"]);
  });
});
