import {
  ancestorsOf,
  BOARD_ITEM_TITLE_MAX,
  type BoardColumn,
  type BoardItem,
  childrenOf,
  compareSiblings,
  TASK_PROMPT_MAX,
} from "@trackwall/protocol";

/**
 * The board as the Plan view shows it (ADR-133): the inbox of ideas, the business projects, and under each its tree of
 * items in their order. Indent and outdent are moves the daemon makes (`board/move`); here only where they lead.
 */

/** What the left column selects: the inbox, or one project with its tree. */
export type PlanPlace = { kind: "inbox" } | { kind: "project"; id: string };

/** A move as `board/move` takes it: under `parent`, before `before` (`null`: last). */
export interface ItemMove {
  parent: string | null;
  before: string | null;
}

export function projectsOf(items: readonly BoardItem[]): BoardItem[] {
  return items.filter((it) => it.kind === "project").sort(compareSiblings);
}

/** A project is archived once done or dropped; the left column lists those apart. */
export function isArchived(item: BoardItem): boolean {
  return item.column === "done" || item.column === "dropped";
}

/** One row of a project's outline: the item and how deep it lies below the project (0: right under it). */
export interface OutlineRow {
  item: BoardItem;
  depth: number;
}

/**
 * The project's items depth first, as an outline shows them; `folded` items hide what is below them. A cycle in
 * hand-edited files is shown once, not forever.
 */
export function outline(items: readonly BoardItem[], project: string, folded: ReadonlySet<string> = new Set()): OutlineRow[] {
  const rows: OutlineRow[] = [];
  const seen = new Set<string>([project]);
  const walk = (parent: string, depth: number) => {
    for (const item of childrenOf(items, parent)) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      rows.push({ item, depth });
      if (!folded.has(item.id)) walk(item.id, depth + 1);
    }
  };
  walk(project, 0);
  return rows;
}

/** The project an item lies in; `undefined` for an idea in the inbox and its children. */
export function projectOf(items: readonly BoardItem[], item: BoardItem): BoardItem | undefined {
  return [...ancestorsOf(items, item), item].find((it) => it.kind === "project");
}

/** Tab: under the sibling just above, as its last child; `undefined` for the first sibling, which has none above. */
export function indentMove(items: readonly BoardItem[], item: BoardItem): ItemMove | undefined {
  const siblings = childrenOf(items, item.parent);
  const above = siblings[siblings.findIndex((it) => it.id === item.id) - 1];
  return above === undefined ? undefined : { parent: above.id, before: null };
}

/**
 * Shift+Tab: next to its parent, right after it; `undefined` right under a project or in the inbox, where there is no
 * level above that is still an item.
 */
export function outdentMove(items: readonly BoardItem[], item: BoardItem): ItemMove | undefined {
  const parent = items.find((it) => it.id === item.parent);
  if (parent === undefined || parent.kind === "project") return undefined;
  const siblings = childrenOf(items, parent.parent);
  const after = siblings[siblings.findIndex((it) => it.id === parent.id) + 1];
  return { parent: parent.parent, before: after?.id ?? null };
}

/** Alt+↑ and Alt+↓: before the sibling above, or after the one below; `undefined` at either end. */
export function shiftMove(items: readonly BoardItem[], item: BoardItem, direction: "up" | "down"): ItemMove | undefined {
  const siblings = childrenOf(items, item.parent).filter((it) => it.id !== item.id);
  const at = childrenOf(items, item.parent).findIndex((it) => it.id === item.id);
  if (direction === "up") {
    const above = siblings[at - 1];
    return above === undefined ? undefined : { parent: item.parent, before: above.id };
  }
  if (at >= siblings.length) return undefined;
  return { parent: item.parent, before: siblings[at + 1]?.id ?? null };
}

/**
 * The prompt "Start task" offers for an item: where it sits in the plan, its title and body, cut to what a task prompt
 * holds. The user edits it before the start.
 */
export function startPrompt(items: readonly BoardItem[], item: BoardItem): string {
  const above = ancestorsOf(items, item).map((it) => it.title);
  const context = above.length > 0 ? `Part of: ${above.join(" › ")}\n\n` : "";
  const text = `${context}${item.title}${item.body.trim() === "" ? "" : `\n\n${item.body.trim()}`}`;
  return text.length > TASK_PROMPT_MAX ? text.slice(0, TASK_PROMPT_MAX) : text;
}

/**
 * An idea as typed into one line: the title, and the whole text as the body when it is longer than a title holds, so
 * nothing typed is cut off.
 */
export function ideaFields(text: string): { title: string; body: string } | undefined {
  const typed = text.trim().replace(/\s+/g, " ");
  if (typed === "") return undefined;
  if (typed.length <= BOARD_ITEM_TITLE_MAX) return { title: typed, body: "" };
  const cut = typed.slice(0, BOARD_ITEM_TITLE_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return { title: `${space > BOARD_ITEM_TITLE_MAX / 2 ? cut.slice(0, space) : cut}…`, body: typed };
}

/** A column as the Plan view names it. */
export const COLUMN_LABELS: Record<BoardColumn, string> = {
  ideas: "Idea",
  ready: "Ready",
  in_progress: "In progress",
  review: "In review",
  done: "Done",
  dropped: "Dropped",
};

/** The move a key on a focused outline row asks for: Tab, Shift+Tab, Alt+↑ and Alt+↓; `undefined` for any other key. */
export function rowKeyMove(
  press: Pick<KeyboardEvent, "key" | "shiftKey" | "altKey">,
  items: readonly BoardItem[],
  item: BoardItem,
): ItemMove | undefined {
  if (press.key === "Tab") return press.shiftKey ? outdentMove(items, item) : indentMove(items, item);
  if (!press.altKey) return undefined;
  if (press.key === "ArrowUp") return shiftMove(items, item, "up");
  if (press.key === "ArrowDown") return shiftMove(items, item, "down");
  return undefined;
}
