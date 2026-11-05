import { describe, expect, test } from "bun:test";
import type { Session, Task } from "@trackwall/protocol";
import { entryId, type SessionRow } from "../src/lib/session-entries.ts";
import { activeGroup, groupTiles, listGroups, sessionGroups } from "../src/lib/session-groups.ts";

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

  test("each grouped row knows its group's name, size and the entry it sits under; a row alone has none", () => {
    const groups = listGroups(LIST);
    expect(groups.get("payments")).toEqual({ id: "orders", name: "orders-api", colour: 0, level: 1, size: 3, under: "orders-api" });
    expect(groups.get("notifications")).toMatchObject({ level: 2, under: "payments" });
    expect(groups.get("orders")).toMatchObject({ level: 0, under: undefined });
    expect(groups.has("auth")).toBe(false);
  });

  test("the grid shows one group alone, at the list positions of its entries", () => {
    const groups = listGroups(LIST);
    const entries = LIST.map((r) => r.entry);
    const group = activeGroup("orders", groups, entries[2]);
    expect(groupTiles(entries, groups, group).map((t) => [entryId(t.entry), t.position])).toEqual([
      ["orders", 2],
      ["payments", 3],
      ["notifications", 4],
    ]);
  });

  test("a selection outside the picked group, or no group picked, shows the whole list", () => {
    const groups = listGroups(LIST);
    const entries = LIST.map((r) => r.entry);
    expect(activeGroup("orders", groups, entries[0])).toBeUndefined();
    expect(activeGroup(null, groups, entries[2])).toBeUndefined();
    expect(groupTiles(entries, groups, undefined)).toHaveLength(4);
  });
});

/** A session in a repo root, with only what a group needs; the rest of `Session` does not matter here. */
function sessionRow(id: string, repo: string, depth: number): SessionRow {
  return { entry: { kind: "session", session: { id, repo, supervisor: false } as Session }, depth, children: 0, supervised: false };
}

function taskRow(id: string, repo: string, depth: number): SessionRow {
  return { entry: { kind: "task", task: { id, repo } as Task, session: undefined }, depth, children: 0, supervised: false };
}

const LIST = [
  sessionRow("auth", "auth-gateway", 0),
  sessionRow("orders", "orders-api", 0),
  taskRow("payments", "payments", 1),
  taskRow("notifications", "notifications", 2),
];
