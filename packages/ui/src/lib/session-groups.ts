/**
 * Groups of related sessions on the Sessions list (§4.4, ADR-48): a main session with every task and proposal under
 * it, at any depth, as `sessionRows` places them. A group is the run of rows from one top-level row to the next, so it
 * needs no tree of its own. Only a group of two or more rows counts: a session alone gets no colour, so a colour always
 * means "these belong together". The colours go round in list order, and the grid can show one group alone.
 */

import type { GridTile } from "./session-grid.ts";

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

/** What a grid tile shows of its group: its colour and the name of the entry it sits under (none for the top one). */
export interface TileGroup {
  colour: number;
  under: string | undefined;
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

/**
 * The grid's tiles: the whole list, or with a filter only the entries of that group, at their list positions. A filter
 * whose group is gone (its top row closed, or its last task ended) shows the whole list.
 */
export function groupTiles<Entry>(
  entries: readonly Entry[],
  groups: readonly (RowGroup | null)[],
  filter: string | null,
): GridTile<Entry>[] {
  const tiles = entries.map((entry, i) => ({ entry, position: i + 1, group: groups[i]?.id }));
  const inGroup = tiles.filter((t) => t.group === filter);
  return (filter === null || inGroup.length === 0 ? tiles : inGroup).map(({ entry, position }) => ({ entry, position }));
}
