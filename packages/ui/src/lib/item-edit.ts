import type { BoardItem } from "@trackwall/protocol";

/**
 * Editing an item's text while others write to it (ADR-232). "Edit" keeps the item as it was when the edit started (the
 * base) and the fields the user typed into (the draft); the board refreshes underneath, where an agent's `update_item` or
 * a task's move may change the item. A field the user did not touch shows and keeps the board's current text, a field
 * only the user changed is saved, and a field both changed is a conflict the user settles. The save sends only the
 * user's fields and names the version it was made on, which the daemon refuses once the item has moved past it.
 */

const TEXT_FIELDS = ["title", "body", "link"] as const;
export type TextField = (typeof TEXT_FIELDS)[number];

/** What the user typed, by field; a field never typed into is missing. */
export type TextDraft = Partial<Record<TextField, string>>;

/** The fields as the form shows them: the user's text where they typed, else the item's current text. */
export function shownText(draft: TextDraft, current: BoardItem): Record<TextField, string> {
  return { title: draft.title ?? current.title, body: draft.body ?? current.body, link: draft.link ?? current.link ?? "" };
}

type ItemText = Pick<BoardItem, TextField>;

/** A typed field as it would be stored: a title and a link without the spaces around, an empty link as none. */
function stored(draft: TextDraft, field: TextField): ItemText[TextField] | undefined {
  const typed = draft[field];
  if (typed === undefined) return undefined;
  if (field === "body") return typed;
  const trimmed = typed.trim();
  return field === "link" && trimmed === "" ? null : trimmed;
}

export type SavePlan =
  | { kind: "unchanged" }
  /** The user emptied the title, which an item needs. */
  | { kind: "no_title" }
  /** Fields the user changed that someone else also changed since the edit started, to someone else's text. */
  | { kind: "conflict"; fields: TextField[] }
  | { kind: "save"; change: Partial<ItemText>; expectedUpdatedAt: string };

/** What Save does now, from the edit's base, the item as the board shows it now and the user's draft. */
export function planSave(base: BoardItem, current: BoardItem, draft: TextDraft): SavePlan {
  const change: Partial<ItemText> = {};
  const conflicts: TextField[] = [];
  for (const field of TEXT_FIELDS) {
    const value = stored(draft, field);
    // Never typed into, or already what the board holds: nothing to write. Text typed back to the base while someone
    // else changed the field still differs from the board, so it is a conflict, not a silent no-op.
    if (value === undefined || value === current[field]) continue;
    if (current[field] !== base[field]) conflicts.push(field);
    Object.assign(change, { [field]: value });
  }
  if (conflicts.length > 0) return { kind: "conflict", fields: conflicts };
  if (change.title === "") return { kind: "no_title" };
  if (Object.keys(change).length === 0) return { kind: "unchanged" };
  return { kind: "save", change, expectedUpdatedAt: current.updatedAt };
}

/** The draft without the user's text of `fields`, which then follow the board again ("Use theirs"). */
export function withoutFields(draft: TextDraft, fields: readonly TextField[]): TextDraft {
  return Object.fromEntries(Object.entries(draft).filter(([field]) => !fields.some((f) => f === field)));
}

const FIELD_NAMES: Record<TextField, string> = { title: "title", body: "notes", link: "ticket link" };

/** What the form says about a conflict, e.g. "You and someone else (maybe an agent) both changed the notes since you started this edit." */
export function conflictNotice(fields: readonly TextField[]): string {
  const names = fields.map((field) => FIELD_NAMES[field]);
  const listed = names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `You and someone else (maybe an agent) both changed the ${listed} since you started this edit.`;
}
