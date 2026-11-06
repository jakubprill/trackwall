import { describe, expect, test } from "bun:test";
import type { BoardItem } from "@trackwall/protocol";
import { cardKeyMove, projectBoard } from "../src/lib/project-board.ts";

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

// Checkout redesign (p)
//   Pay later (pay): in progress
//     Accept PAY_LATER (accept): in review
//     Retry the call (retry): in progress
//     Reminder e-mail (remind): dropped
//   Show retries (show): done
//     Old note (note): ready, below a done item
//   One-page checkout (one): idea, not split
const items = [
  item("p", { kind: "project", parent: null }),
  item("pay", { column: "in_progress", order: 1 }),
  item("accept", { parent: "pay", column: "review", order: 1 }),
  item("retry", { parent: "pay", column: "in_progress", order: 2 }),
  item("remind", { parent: "pay", column: "dropped", order: 3 }),
  item("show", { column: "done", order: 2 }),
  item("note", { parent: "show" }),
  item("one", { column: "ideas", order: 3 }),
  item("elsewhere", { parent: "q" }),
];

const ids = (cards: readonly { item: BoardItem }[]) => cards.map((c) => c.item.id);

describe("a project of Plan as a board (ADR-217)", () => {
  test("the cards are the items not split further, each in its column in outline order, and dropped ones are only counted", () => {
    const board = projectBoard(items, "p");
    expect(ids(board.columns.ideas)).toEqual(["one"]);
    expect(ids(board.columns.ready)).toEqual([]);
    expect(ids(board.columns.in_progress)).toEqual(["retry"]);
    expect(ids(board.columns.review)).toEqual(["accept"]);
    expect(board.dropped).toBe(1);
  });

  test("a card names the item it was split from, and none right under the project", () => {
    const board = projectBoard(items, "p");
    expect(board.columns.review[0]?.splitFrom?.id).toBe("pay");
    expect(board.columns.ideas[0]?.splitFrom).toBeUndefined();
  });

  test("an item below a done item is a done card that moves with that item, not on its own", () => {
    const [card] = projectBoard(items, "p").columns.done;
    expect(card?.item.id).toBe("note");
    expect(card?.closedAbove).toBe(true);
    expect(projectBoard(items, "p").columns.review[0]?.closedAbove).toBe(false);
  });

  test("Alt+← and Alt+→ move a card one column and stop at either end; other keys are left alone", () => {
    const key = (k: string, mods: Partial<Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey">> = {}) => ({
      key: k,
      altKey: true,
      ctrlKey: false,
      metaKey: false,
      ...mods,
    });
    expect(cardKeyMove(key("ArrowRight"), "ready")).toBe("in_progress");
    expect(cardKeyMove(key("ArrowLeft"), "ready")).toBe("ideas");
    expect(cardKeyMove(key("ArrowLeft"), "ideas")).toBeUndefined();
    expect(cardKeyMove(key("ArrowRight"), "done")).toBeUndefined();
    expect(cardKeyMove(key("ArrowRight", { altKey: false }), "ready")).toBeUndefined();
    expect(cardKeyMove(key("ArrowRight", { ctrlKey: true }), "ready")).toBeUndefined();
    expect(cardKeyMove(key("ArrowUp"), "ready")).toBeUndefined();
  });
});
