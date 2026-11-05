/**
 * Groups of related sessions on the Sessions list (§4.4, ADR-48): a main session with every task and proposal under
 * it, at any depth, as `sessionRows` places them. A group is the run of rows from one top-level row to the next, so it
 * needs no tree of its own. Only a group of two or more rows counts: a session alone gets no colour, so a colour always
 * means "these belong together". The colours go round in list order, and the grid can show one group alone.
 */

import { entryId, entryName, type SessionEntry, type SessionRow } from "./session-entries.ts";
import { type GridTile, listTiles } from "./session-grid.ts";

/** How many group colours there are (`--group-1` … `--group-4` in `index.css`); after four groups they repeat. */
const GROUP_COLOURS = 4;

/** What a row of the list needs for its group: its entry's id, depth, and whether it sits under the supervisor heading. */
export interface GroupedRow {
  id: string;
  depth: number;
  supervised: boolean;
}

/** A row's place in its group. */
export interface RowGroup {
  /** The id of the group's top row, the main session or task that the rest sits under. */
  id: string;
  /** The group's colour, from 0 to `GROUP_COLOURS` − 1. */
  colour: number;
  /** Levels under the group's top row: 0 for the top row itself. */
  level: number;
  /** The index of the row this one sits directly under; `undefined` for the top row. */
  parent: number | undefined;
}

/** What a list row and its grid tile show of the row's group. */
export interface EntryGroup {
  /** The id of the group's top entry. */
  id: string;
  /** The top entry's name, for the filter chip. */
  name: string;
  colour: number;
  /** Levels under the group's top entry: 0 for the top entry itself. */
  level: number;
  /** How many entries the group has, the top one included. */
  size: number;
  /** The name of the entry this one sits directly under; `undefined` for the top entry. */
  under: string | undefined;
}

/** The group of every grouped row of the Sessions list, by entry id; a row alone is not in the map. */
export function listGroups(rows: readonly SessionRow[]): Map<string, EntryGroup> {
  const groups = sessionGroups(rows.map((r) => ({ id: entryId(r.entry), depth: r.depth, supervised: r.supervised })));
  const byId = new Map(rows.map((r) => [entryId(r.entry), r.entry]));
  const sizes = new Map<string, number>();
  for (const group of groups) if (group) sizes.set(group.id, (sizes.get(group.id) ?? 0) + 1);
  return new Map(
    rows.flatMap((row, i): [string, EntryGroup][] => {
      const group = groups[i];
      const top = group && byId.get(group.id);
      if (!group || !top) return [];
      const parent = group.parent === undefined ? undefined : rows[group.parent]?.entry;
      const under = parent && entryName(parent);
      return [
        [
          entryId(row.entry),
          { id: group.id, name: entryName(top), colour: group.colour, level: group.level, size: sizes.get(group.id) ?? 0, under },
        ],
      ];
    }),
  );
}

/**
 * The group the grid shows alone: the one the user picked, while the selected entry is in it. A selection that lands
 * outside it from elsewhere (the tray, a link) shows the whole list again.
 */
export function activeGroup(
  picked: string | null,
  groups: ReadonlyMap<string, EntryGroup>,
  selected: SessionEntry | undefined,
): EntryGroup | undefined {
  const group = selected && groups.get(entryId(selected));
  return picked !== null && group?.id === picked ? group : undefined;
}

/** The grid's tiles: the whole list, or only the entries of `group`, at their list positions. */
export function groupTiles(
  entries: readonly SessionEntry[],
  groups: ReadonlyMap<string, EntryGroup>,
  group: EntryGroup | undefined,
): GridTile<SessionEntry>[] {
  const tiles = listTiles(entries);
  return group === undefined ? tiles : tiles.filter((t) => groups.get(entryId(t.entry))?.id === group.id);
}

/**
 * Every row's group, by index, or `null` for a row that is alone. The supervisor's work starts one level down, under
 * its heading (ADR-58), so there a group starts at depth 1.
 */
export function sessionGroups(rows: readonly GroupedRow[]): (RowGroup | null)[] {
  const tops: GroupedRow[] = [];
  for (const row of rows) {
    const top = tops.at(-1);
    tops.push(top === undefined || row.depth <= topDepth(row) ? row : top);
  }
  const sizes = new Map<GroupedRow, number>();
  for (const top of tops) sizes.set(top, (sizes.get(top) ?? 0) + 1);
  const colours = new Map<GroupedRow, number>();
  return rows.map((row, i) => {
    const top = tops[i];
    if (top === undefined || (sizes.get(top) ?? 0) < 2) return null;
    const colour = colours.get(top) ?? colours.size % GROUP_COLOURS;
    colours.set(top, colour);
    return { id: top.id, colour, level: Math.max(row.depth - top.depth, 0), parent: parentOf(rows, tops, i) };
  });
}

/** The depth a group starts at: under the supervisor heading one level down. */
function topDepth(row: GroupedRow): number {
  return row.supervised ? 1 : 0;
}

/** The nearest row above `i` in its group one level up: rows come in tree order, so that is its parent. */
function parentOf(rows: readonly GroupedRow[], tops: readonly GroupedRow[], i: number): number | undefined {
  const depth = rows[i]?.depth ?? 0;
  for (let j = i - 1; j >= 0 && tops[j] === tops[i]; j--) if (rows[j]?.depth === depth - 1) return j;
  return undefined;
}
