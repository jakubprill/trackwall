import { describe, expect, test } from "bun:test";
import type { BoardItem } from "@trackwall/protocol";
import { canMoveCard, cardKeyMove, projectBoard } from "../src/lib/project-board.ts";
import { columnNamed, isCardDrag } from "../src/lib/use-card-drag.ts";

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

  test("the user moves a card to any other column, but not one below a closed item, which moves with it", () => {
    const board = projectBoard(items, "p");
    const [accept] = board.columns.review;
    const [note] = board.columns.done;
    if (!accept || !note) throw new Error("the board lacks its cards");
    expect(canMoveCard(accept, "done")).toBe(true);
    expect(canMoveCard(accept, "ideas")).toBe(true);
    expect(canMoveCard(accept, "review")).toBe(false);
    expect(canMoveCard(note, "ready")).toBe(false);
    expect(board.cards.get("accept")).toBe(accept);
  });

  test("an item whose every part was dropped is a card of its own again", () => {
    const board = projectBoard([...items, item("lone", { order: 4 }), item("gone", { parent: "lone", column: "dropped" })], "p");
    expect(ids(board.columns.ready)).toEqual(["lone"]);
    expect(board.dropped).toBe(2);
  });

  test("hand-edited files with a cycle show each item at most once", () => {
    const loop = [item("p", { kind: "project", parent: null }), item("x", { parent: "y" }), item("y", { parent: "x" }), item("z")];
    expect(ids(projectBoard(loop, "p").columns.ready)).toEqual(["z"]);
  });

  test("Alt+← and Alt+→ move a card one column and stop at either end, where the key is still taken; other keys are left alone", () => {
    const key = (k: string, mods: Partial<Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey">> = {}) => ({
      key: k,
      altKey: true,
      ctrlKey: false,
      metaKey: false,
      ...mods,
    });
    expect(cardKeyMove(key("ArrowRight"), "ready")).toBe("in_progress");
    expect(cardKeyMove(key("ArrowLeft"), "ready")).toBe("ideas");
    expect(cardKeyMove(key("ArrowLeft"), "ideas")).toBeNull();
    expect(cardKeyMove(key("ArrowRight"), "done")).toBeNull();
    expect(cardKeyMove(key("ArrowRight", { altKey: false }), "ready")).toBeUndefined();
    expect(cardKeyMove(key("ArrowRight", { ctrlKey: true }), "ready")).toBeUndefined();
    expect(cardKeyMove(key("ArrowUp"), "ready")).toBeUndefined();
  });

  test("a pressed card is dragged once the pointer goes 4 pixels in any direction, and clicked below that", () => {
    expect(isCardDrag({ x: 100, y: 100 }, { x: 103, y: 100 })).toBe(false);
    expect(isCardDrag({ x: 100, y: 100 }, { x: 102, y: 102 })).toBe(false);
    expect(isCardDrag({ x: 100, y: 100 }, { x: 104, y: 100 })).toBe(true);
    expect(isCardDrag({ x: 100, y: 100 }, { x: 97, y: 96 })).toBe(true);
  });

  test("the column under a dragged card is read from its element's name, and anything else is no column", () => {
    expect(columnNamed("in_progress")).toBe("in_progress");
    expect(columnNamed("dropped")).toBeUndefined();
    expect(columnNamed("")).toBeUndefined();
    expect(columnNamed(null)).toBeUndefined();
    expect(columnNamed(undefined)).toBeUndefined();
  });
});
