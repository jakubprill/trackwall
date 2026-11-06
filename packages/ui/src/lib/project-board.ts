import { ancestorsOf, type BoardColumn, type BoardItem } from "@trackwall/protocol";
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
  dropped: number;
}

/** The project's items with nothing below them, in outline order, each in the column it counts in. */
export function projectBoard(items: readonly BoardItem[], project: string): ProjectBoard {
  const columns: Record<BoardViewColumn, BoardCard[]> = { ideas: [], ready: [], in_progress: [], review: [], done: [] };
  let dropped = 0;
  const rows = outline(items, project);
  const split = new Set(rows.map(({ item }) => item.parent));
  for (const { item } of rows) {
    if (split.has(item.id)) continue;
    const column = countedColumn(items, item, project);
    if (column === "dropped") {
      dropped += 1;
      continue;
    }
    const above = ancestorsOf(items, item).at(-1);
    columns[column].push({
      item,
      splitFrom: above?.id === project ? undefined : above,
      closedAbove: column !== item.column,
    });
  }
  return { columns, dropped };
}

/** Alt+← and Alt+→ on a focused card: the column next to it, or `undefined` at either end and for any other key. */
export function cardKeyMove(
  press: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey">,
  column: BoardViewColumn,
): BoardViewColumn | undefined {
  if (!press.altKey || press.ctrlKey || press.metaKey) return undefined;
  const step = press.key === "ArrowRight" ? 1 : press.key === "ArrowLeft" ? -1 : 0;
  if (step === 0) return undefined;
  return BOARD_COLUMNS[BOARD_COLUMNS.indexOf(column) + step];
}
