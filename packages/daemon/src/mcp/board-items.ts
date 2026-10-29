import {
  BOARD_EXCERPT_MAX,
  type BoardItem,
  type BoardItemSummary,
  compareSiblings,
  type GetItemResult,
  type Task,
} from "@trackwall/protocol";

/**
 * The board as the MCP tools show it (ADR-133): a list without bodies, with what hangs under each item, and one item
 * with the path down to it. Pure functions over the board and the task list, which come from two modules.
 */

export interface ItemFilter {
  kind?: BoardItem["kind"];
  parent?: string;
  inbox?: boolean;
  column?: BoardItem["column"];
  repo?: string;
  query?: string;
}

export function matchesItem(item: BoardItem, filter: ItemFilter): boolean {
  const text = filter.query?.toLowerCase();
  return (
    (filter.kind === undefined || item.kind === filter.kind) &&
    (filter.parent === undefined || item.parent === filter.parent) &&
    (filter.inbox !== true || isIdea(item)) &&
    (filter.column === undefined || item.column === filter.column) &&
    (filter.repo === undefined || item.repos.includes(filter.repo)) &&
    (text === undefined || item.title.toLowerCase().includes(text) || item.body.toLowerCase().includes(text))
  );
}

/** An idea in the inbox: an item no one has filed under a project yet. */
function isIdea(item: BoardItem): boolean {
  return item.kind === "item" && item.parent === null;
}

export function itemSummary(item: BoardItem, items: readonly BoardItem[], tasks: readonly Task[]): BoardItemSummary {
  const { body, ...fields } = item;
  return {
    ...fields,
    excerpt: body.length > BOARD_EXCERPT_MAX ? `${body.slice(0, BOARD_EXCERPT_MAX)}…` : body,
    children: items.filter((it) => it.parent === item.id).length,
    tasks: tasks.filter((t) => t.item === item.id).length,
  };
}

/** Siblings in the order the Plan view shows them. */
export function inOrder(items: readonly BoardItem[]): BoardItem[] {
  return [...items].sort(compareSiblings);
}

/** The items above `item`, from the top down; a cycle in hand-edited files ends the walk. */
export function itemPath(item: BoardItem, items: readonly BoardItem[]): GetItemResult["path"] {
  const path: GetItemResult["path"] = [];
  const seen = new Set([item.id]);
  for (let at = items.find((it) => it.id === item.parent); at !== undefined && !seen.has(at.id); ) {
    path.unshift({ id: at.id, kind: at.kind, title: at.title });
    seen.add(at.id);
    const parent = at.parent;
    at = items.find((it) => it.id === parent);
  }
  return path;
}
