import { describe, expect, test } from "bun:test";
import { type BoardItem, TASK_PROMPT_MAX } from "@trackwall/protocol";
import { childrenOf, ideaFields, indentMove, outdentMove, outline, projectOf, shiftMove, startPrompt } from "../src/lib/board-tree.ts";

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

// Order history
//   Customers see their history (a)
//     Endpoint in the BFF (a1)
//     List on the account page (a2)
//   Export to CSV (b)
const project = item("p", { kind: "project", title: "Order history", column: "ready" });
const a = item("a", { parent: "p", order: 1, title: "Customers see their history" });
const a1 = item("a1", { parent: "a", order: 1, title: "Endpoint in the BFF", body: "GET /orders/history\n" });
const a2 = item("a2", { parent: "a", order: 2, title: "List on the account page" });
const b = item("b", { parent: "p", order: 2, title: "Export to CSV" });
const idea = item("idea", { title: "Cache the lookup" });
const items = [b, a2, idea, a1, project, a];

describe("the Plan view's tree (ADR-133)", () => {
  test("a project's outline lists its items depth first in their order, and a folded item hides what is below it", () => {
    expect(outline(items, "p").map((row) => [row.item.id, row.depth])).toEqual([
      ["a", 0],
      ["a1", 1],
      ["a2", 1],
      ["b", 0],
    ]);
    expect(outline(items, "p", new Set(["a"])).map((row) => row.item.id)).toEqual(["a", "b"]);
    expect(childrenOf(items, null).map((it) => it.id)).toEqual(["idea"]);
  });

  test("an outline of hand-edited files with a cycle shows each item once", () => {
    const loop = [project, item("x", { parent: "y" }), item("y", { parent: "x" }), item("z", { parent: "p" })];
    expect(outline(loop, "p").map((row) => row.item.id)).toEqual(["z"]);
    expect(projectOf(loop, item("x", { parent: "y" }))).toBeUndefined();
    expect(projectOf(items, a1)?.id).toBe("p");
  });

  test("Tab puts an item under the one above it, Shift+Tab takes it out right after its parent, and not past the project", () => {
    expect(indentMove(items, b)).toEqual({ parent: "a", before: null });
    expect(indentMove(items, a)).toBeUndefined();
    expect(outdentMove(items, a1)).toEqual({ parent: "p", before: "b" });
    expect(outdentMove(items, a)).toBeUndefined();
    expect(outdentMove(items, idea)).toBeUndefined();
  });

  test("Alt+↑ and Alt+↓ move an item among its siblings and stop at either end", () => {
    expect(shiftMove(items, a2, "up")).toEqual({ parent: "a", before: "a1" });
    expect(shiftMove(items, a1, "down")).toEqual({ parent: "a", before: null });
    expect(shiftMove(items, a1, "up")).toBeUndefined();
    expect(shiftMove(items, a2, "down")).toBeUndefined();
  });

  test("Start task offers where the item sits in the plan, its title and its body, cut to what a prompt holds", () => {
    expect(startPrompt(items, a1)).toBe(
      "Part of: Order history › Customers see their history\n\nEndpoint in the BFF\n\nGET /orders/history",
    );
    expect(startPrompt(items, idea)).toBe("Cache the lookup");
    expect(startPrompt(items, { ...idea, body: "x".repeat(TASK_PROMPT_MAX) })).toHaveLength(TASK_PROMPT_MAX);
  });

  test("an idea typed on one line becomes a title, and a long one keeps all its words in the body", () => {
    expect(ideaFields("  Retry   the export ")).toEqual({ title: "Retry the export", body: "" });
    expect(ideaFields("   ")).toBeUndefined();
    const long = `Retry the invoice export after a timeout ${"and tell the user what happened ".repeat(5)}`.trim();
    const fields = ideaFields(long);
    expect(fields?.body).toBe(long);
    expect(fields?.title.length).toBeLessThanOrEqual(120);
    expect(fields?.title.endsWith("…")).toBe(true);
  });
});
