import { BOARD_EXCERPT_MAX, type BoardItem, type BoardItemSummary, type Task } from "@trackwall/protocol";

/**
 * The board as the MCP tools show it (ADR-133): which items a filter takes, and a list without bodies, with what hangs
 * under each item. Pure functions over the board and the task list, which come from two modules.
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

/** Items as `list_items` lists them: without bodies, with how many items and tasks hang under each. */
export function itemSummaries(listed: readonly BoardItem[], items: readonly BoardItem[], tasks: readonly Task[]): BoardItemSummary[] {
  const children = countBy(items.filter((it) => it.kind === "item").map((it) => it.parent));
  const started = countBy(tasks.map((t) => t.item));
  return listed.map(({ body, ...fields }) => ({
    ...fields,
    excerpt: body.length > BOARD_EXCERPT_MAX ? `${body.slice(0, BOARD_EXCERPT_MAX)}…` : body,
    children: children.get(fields.id) ?? 0,
    tasks: started.get(fields.id) ?? 0,
  }));
}

function countBy(keys: readonly (string | null)[]): Map<string | null, number> {
  const counts = new Map<string | null, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}
