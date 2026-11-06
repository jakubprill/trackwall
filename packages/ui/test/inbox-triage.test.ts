import { describe, expect, test } from "bun:test";
import type { BoardItem, Task } from "@trackwall/protocol";
import {
  filingChoices,
  ideaAfter,
  ideaAge,
  ideaAuthor,
  ideaGroups,
  inboxIdeas,
  matchesFilter,
  noteLine,
  stepIdea,
  triageKey,
} from "../src/lib/inbox-triage.ts";

function item(id: string, fields: Partial<BoardItem> = {}): BoardItem {
  return {
    id,
    kind: "item",
    title: id,
    body: "",
    parent: null,
    column: "ideas",
    order: 1,
    repos: [],
    link: null,
    createdBy: { kind: "user" },
    createdAt: "2026-11-01T09:00:00.000Z",
    updatedAt: "2026-11-01T09:00:00.000Z",
    ...fields,
  };
}

// Local times, since the groups follow the user's calendar.
const now = new Date(2026, 10, 6, 10, 0);
const at = (day: number, hour: number) => new Date(2026, 10, day, hour, 0).toISOString();

const key = (k: string, mods: Partial<Pick<KeyboardEvent, "ctrlKey" | "altKey" | "metaKey">> = {}) => ({
  key: k,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe("the inbox as a place to sort ideas (ADR-214)", () => {
  test("open ideas come newest first, and dropped ideas and items filed in a project are not among them", () => {
    const project = item("p", { kind: "project", column: "ready" });
    const items = [
      item("old", { createdAt: at(1, 9) }),
      item("new", { createdAt: at(6, 8) }),
      item("dropped", { column: "dropped", createdAt: at(5, 9) }),
      item("filed", { parent: "p", createdAt: at(6, 9) }),
      project,
    ];
    const { open, dropped } = inboxIdeas(items);
    expect(open.map((it) => it.id)).toEqual(["new", "old"]);
    expect(dropped.map((it) => it.id)).toEqual(["dropped"]);
  });

  test("an idea is from today after local midnight, from this week within the last seven days, and older before that", () => {
    expect(ideaAge(at(6, 0), now)).toBe("today");
    expect(ideaAge(at(5, 23), now)).toBe("week");
    expect(ideaAge(at(0, 0), now)).toBe("week");
    expect(ideaAge(at(-1, 23), now)).toBe("older");
  });

  test("the groups keep the newest-first order and leave out an age without ideas", () => {
    const ideas = [
      item("a", { createdAt: at(6, 9) }),
      item("b", { createdAt: at(6, 7) }),
      item("c", { createdAt: "2026-09-01T09:00:00.000Z" }),
    ];
    expect(ideaGroups(ideas, now).map((g) => [g.age, g.ideas.map((it) => it.id)])).toEqual([
      ["today", ["a", "b"]],
      ["older", ["c"]],
    ]);
  });

  test("the filter tells the ideas agents wrote from the user's own", () => {
    const mine = item("mine");
    const agents = item("agents", { createdBy: { kind: "agent", task: null } });
    expect([mine, agents].filter((it) => matchesFilter(it, "agents")).map((it) => it.id)).toEqual(["agents"]);
    expect([mine, agents].filter((it) => matchesFilter(it, "mine")).map((it) => it.id)).toEqual(["mine"]);
    expect([mine, agents].filter((it) => matchesFilter(it, "all"))).toHaveLength(2);
  });

  test("an agent's idea names the task it worked on while that task is listed, and only says an agent once it has ended", () => {
    const task = { id: "4c1d1f0e-0000-4000-8000-000000000001", repo: "inventory", title: "Hide deleted reviews" } as Task;
    const fromTask = item("x", { createdBy: { kind: "agent", task: task.id } });
    expect(ideaAuthor(fromTask, [task])).toEqual({ agent: true, task });
    expect(ideaAuthor(fromTask, [])).toEqual({ agent: true, task: undefined });
    expect(ideaAuthor(item("y"), [task])).toEqual({ agent: false });
  });

  test("the row shows the first line of the notes", () => {
    expect(noteLine("\n  The page calls pricing on every render.\nMore detail\n")).toBe("The page calls pricing on every render.");
    expect(noteLine("")).toBe("");
  });

  test("projects whose items name one of the idea's repos are offered first, archived projects not at all", () => {
    const checkout = item("checkout", { kind: "project", column: "ready", order: 1 });
    const prices = item("prices", { kind: "project", column: "ready", order: 2 });
    const done = item("done", { kind: "project", column: "done", order: 3 });
    const items = [
      checkout,
      prices,
      done,
      item("pay", { parent: "checkout", repos: ["payments"] }),
      item("event", { parent: "prices", repos: ["pricing"] }),
      item("cache", { parent: "event", repos: ["shop-bff"] }),
      item("old", { parent: "done", repos: ["shop-bff"] }),
    ];
    const idea = item("idea", { repos: ["shop-bff"] });
    expect(filingChoices(items, idea).map((c) => [c.project.id, c.sharedRepos])).toEqual([
      ["prices", ["shop-bff"]],
      ["checkout", []],
    ]);
  });

  test("J, K and the arrows move, F, S and D act, digits pick a project only while the list is open, and modified keys are left alone", () => {
    expect(triageKey(key("j"), false)).toEqual({ kind: "next" });
    expect(triageKey(key("ArrowUp"), false)).toEqual({ kind: "previous" });
    expect(triageKey(key("F"), false)).toEqual({ kind: "file" });
    expect(triageKey(key("s"), false)).toEqual({ kind: "start" });
    expect(triageKey(key("d"), false)).toEqual({ kind: "drop" });
    expect(triageKey(key("2"), true)).toEqual({ kind: "file-in", choice: 1 });
    expect(triageKey(key("2"), false)).toBeUndefined();
    expect(triageKey(key("n", { altKey: true }), false)).toBeUndefined();
    expect(triageKey(key("d", { ctrlKey: true }), false)).toBeUndefined();
    expect(triageKey(key("x"), false)).toBeUndefined();
  });

  test("moving stops at either end, and an idea that leaves hands the selection to the next one, or the one before at the end", () => {
    const ideas = [item("a"), item("b"), item("c")];
    expect(stepIdea(ideas, "a", -1)).toBe("a");
    expect(stepIdea(ideas, "a", 1)).toBe("b");
    expect(stepIdea(ideas, "c", 1)).toBe("c");
    expect(stepIdea(ideas, undefined, 1)).toBe("a");
    expect(ideaAfter(ideas, "b")).toBe("c");
    expect(ideaAfter(ideas, "c")).toBe("b");
    expect(ideaAfter([item("a")], "a")).toBeUndefined();
  });
});
