import { describe, expect, test } from "bun:test";
import { groupTiles, sessionGroups } from "../src/lib/session-groups.ts";

describe("session groups", () => {
  test("a chain three deep is one group: each row knows its level and the row it sits under", () => {
    const rows = [
      { id: "orders-api", depth: 0, supervised: false },
      { id: "payments", depth: 1, supervised: false },
      { id: "notifications", depth: 2, supervised: false },
    ];
    expect(sessionGroups(rows)).toEqual([
      { id: "orders-api", colour: 0, level: 0, parent: undefined },
      { id: "orders-api", colour: 0, level: 1, parent: 0 },
      { id: "orders-api", colour: 0, level: 2, parent: 1 },
    ]);
  });

  test("a session alone has no group, so only rows that belong together get a colour", () => {
    const rows = [
      { id: "auth-gateway", depth: 0, supervised: false },
      { id: "web-shop", depth: 0, supervised: false },
      { id: "cart", depth: 1, supervised: false },
    ];
    expect(sessionGroups(rows)).toEqual([
      null,
      { id: "web-shop", colour: 0, level: 0, parent: undefined },
      { id: "web-shop", colour: 0, level: 1, parent: 1 },
    ]);
  });

  test("two tasks under one session both sit under it, and a task under the second sits under that one", () => {
    const rows = [
      { id: "main", depth: 0, supervised: false },
      { id: "first", depth: 1, supervised: false },
      { id: "second", depth: 1, supervised: false },
      { id: "under-second", depth: 2, supervised: false },
    ];
    expect(sessionGroups(rows).map((g) => g?.parent)).toEqual([undefined, 0, 0, 2]);
  });

  test("the colours go round in list order and repeat after four groups", () => {
    const rows = ["a", "b", "c", "d", "e"].flatMap((id) => [
      { id, depth: 0, supervised: false },
      { id: `${id}-task`, depth: 1, supervised: false },
    ]);
    expect(sessionGroups(rows).map((g) => g?.colour)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 0, 0]);
  });

  test("the supervisor's work starts groups one level down, under its heading", () => {
    const rows = [
      { id: "billing", depth: 1, supervised: true },
      { id: "billing-follow-up", depth: 2, supervised: true },
      { id: "lonely", depth: 1, supervised: true },
      { id: "shop", depth: 0, supervised: false },
    ];
    expect(sessionGroups(rows)).toEqual([
      { id: "billing", colour: 0, level: 0, parent: undefined },
      { id: "billing", colour: 0, level: 1, parent: 0 },
      null,
      null,
    ]);
  });

  test("the grid filtered to one group shows only its entries, at their places in the list", () => {
    const group = { id: "orders-api", colour: 0, level: 0, parent: undefined };
    const groups = [null, group, { ...group, level: 1, parent: 1 }, null];
    expect(groupTiles(["auth", "orders-api", "payments", "shop"], groups, "orders-api")).toEqual([
      { entry: "orders-api", position: 2 },
      { entry: "payments", position: 3 },
    ]);
  });

  test("without a filter, or once its group is gone, the grid shows the whole list", () => {
    expect(groupTiles(["auth", "shop"], [null, null], null)).toEqual([
      { entry: "auth", position: 1 },
      { entry: "shop", position: 2 },
    ]);
    expect(groupTiles(["auth", "shop"], [null, null], "orders-api")).toHaveLength(2);
  });
});
