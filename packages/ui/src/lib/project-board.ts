import type { BoardColumn, BoardItem } from "@trackwall/protocol";
import { outline } from "./board-tree.ts";
import { countedColumn } from "./plan-progress.ts";

/**
 * A project of Plan as a board (ADR-217): the items not split further, as cards in the columns from an idea to done, each
 * with the item it was split from. The board is another view of the same tree: a card's column is the item's column, and
 * moving a card changes only that; where an item sits in the tree is the outline's business.
 */

/** The columns of the board, left to right; dropped cards are counted below it, not shown. */
export const BOARD_COLUMNS = ["ideas", "ready", "in_progress", "review", "done"] as const satisfies readonly BoardColumn[];
export type BoardViewColumn = (typeof BOARD_COLUMNS)[number];

export interface BoardCard {
  item: BoardItem;
  /** The item it was split from, for the line above its title; `undefined` right under the project. */
  splitFrom: BoardItem | undefined;
  /** It lies below a done or dropped item, so it counts in that column and moves with it, not on its own. */
  closedAbove: boolean;
}

export interface ProjectBoard {
  columns: Record<BoardViewColumn, BoardCard[]>;
  /** Every card by its item, for a drop that carries only the id. */
  cards: ReadonlyMap<string, BoardCard>;
  dropped: number;
}

/**
 * The attribute that names a column on its element, so a dragged card finds the column under the pointer. A card is
 * dragged with pointer events, not HTML5 drag and drop: the desktop shell takes every native drag over its window for
 * dropping files (ADR-51), so in WKWebView and WebView2 the page never sees a `dragover` or `drop` (ADR-217).
 */
export const BOARD_COLUMN_ATTRIBUTE = "data-board-column";

/** How far, in CSS pixels, a pressed card goes before it is dragged rather than clicked. */
const CARD_DRAG_DISTANCE = 4;

/** Whether the pointer, pressed on a card at `from`, has gone far enough to drag it. */
export function isCardDrag(from: { x: number; y: number }, to: { x: number; y: number }): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) >= CARD_DRAG_DISTANCE;
}

/** The column named by `BOARD_COLUMN_ATTRIBUTE` of the element under the pointer, `undefined` off the columns. */
export function columnNamed(value: string | null | undefined): BoardViewColumn | undefined {
  return BOARD_COLUMNS.find((column) => column === value);
}

/**
 * The project's items with nothing below them but dropped items, in outline order, each in the column it counts in: an
 * item whose every part was dropped is work of its own again.
 */
export function projectBoard(items: readonly BoardItem[], project: string): ProjectBoard {
  const columns: Record<BoardViewColumn, BoardCard[]> = { ideas: [], ready: [], in_progress: [], review: [], done: [] };
  const cards = new Map<string, BoardCard>();
  let dropped = 0;
  const rows = outline(items, project);
  const split = new Set(rows.filter(({ item }) => item.column !== "dropped").map(({ item }) => item.parent));
  for (const { item } of rows) {
    if (split.has(item.id)) continue;
    const column = countedColumn(items, item, project);
    if (column === "dropped") {
      dropped += 1;
      continue;
    }
    const card = {
      item,
      splitFrom: item.parent === project ? undefined : items.find((it) => it.id === item.parent),
      closedAbove: column !== item.column,
    };
    columns[column].push(card);
    cards.set(item.id, card);
  }
  return { columns, cards, dropped };
}

/**
 * Whether the user can put a card in `to`: any column but its own, unless it lies below a closed item. The user sets any
 * column, as in the item's panel; the daemon then moves it on as its tasks start and report (ADR-213).
 */
export function canMoveCard(card: BoardCard, to: BoardViewColumn): boolean {
  return !card.closedAbove && card.item.column !== to;
}

/**
 * Alt+← and Alt+→ on a focused card: the column next to it, `null` at either end (the key is still the board's, so the
 * window does not go back a page on Alt+←), or `undefined` for any other key.
 */
export function cardKeyMove(
  press: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey">,
  column: BoardViewColumn,
): BoardViewColumn | null | undefined {
  if (!press.altKey || press.ctrlKey || press.metaKey) return undefined;
  const step = press.key === "ArrowRight" ? 1 : press.key === "ArrowLeft" ? -1 : 0;
  if (step === 0) return undefined;
  return BOARD_COLUMNS[BOARD_COLUMNS.indexOf(column) + step] ?? null;
}
