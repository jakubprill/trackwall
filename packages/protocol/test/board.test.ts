import { describe, expect, test } from "bun:test";
import { ancestorsOf, type BoardItem, childrenOf } from "../src/board.ts";

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
    createdAt: "2026-10-29T20:00:00.000Z",
    updatedAt: "2026-10-29T20:00:00.000Z",
    ...fields,
  };
}

describe("the tree of the board (ADR-133)", () => {
  const items = [
    item("checkout", { kind: "project" }),
    item("pay later", { parent: "checkout", order: 2 }),
    item("history", { parent: "checkout", order: 1 }),
    item("bff endpoint", { parent: "history" }),
    item("idea"),
  ];

  test("an item's children come in their order, and the inbox holds the ideas but no project", () => {
    expect(childrenOf(items, "checkout").map((it) => it.id)).toEqual(["history", "pay later"]);
    expect(childrenOf(items, null).map((it) => it.id)).toEqual(["idea"]);
  });

  test("an item's ancestors run from its project down to its parent", () => {
    expect(ancestorsOf(items, item("bff endpoint", { parent: "history" })).map((it) => it.id)).toEqual(["checkout", "history"]);
    expect(ancestorsOf(items, item("idea"))).toEqual([]);
  });

  test("a cycle in files edited by hand ends the walk instead of looping", () => {
    const loop = [item("a", { parent: "b" }), item("b", { parent: "a" })];
    expect(ancestorsOf(loop, item("a", { parent: "b" })).map((it) => it.id)).toEqual(["b"]);
  });
});
