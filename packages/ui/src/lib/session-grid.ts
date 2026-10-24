/**
 * The layout of the Sessions view (ADR-48): one session with its full panel, or a grid of session terminals. Layouts 2
 * and 4 split the list into pages of that many entries and show the page with the selected entry, so a shortcut to any
 * position also turns the page. Auto shows every entry at once, up to `MAX_TILES`, on as many pages as needed.
 */
export const SESSION_LAYOUTS = ["1", "2", "4", "auto"] as const;
export type SessionLayout = (typeof SESSION_LAYOUTS)[number];

/** Nine Copilot CLI terminals in three columns still have over 100 columns each on a 34-inch ultrawide screen (3440 px). */
const MAX_TILES = 9;

/** Width to height of the tile the shape tries to make as large as possible; a terminal reads better wide than tall. */
const TILE_ASPECT = 1.6;

/** A tile: an entry of the list with its position (from 1), which its number and shortcut refer to. */
interface GridTile<Entry> {
  entry: Entry;
  position: number;
}

export interface GridPage<Entry> {
  tiles: GridTile<Entry>[];
  /** Cells of a full page, so that the last page keeps the tile size of the others instead of stretching its tiles. */
  slots: number;
  page: number;
  pages: number;
}

/** Tiles on one page; Auto fits the whole list, at least one tile so that an empty list still has a page. */
export function tilesPerPage(layout: SessionLayout, entries: number): number {
  if (layout === "auto") return Math.min(Math.max(entries, 1), MAX_TILES);
  return Number(layout);
}

/** The page with the selected entry; with no selected entry (−1) the first page. */
export function gridPage<Entry>(layout: SessionLayout, entries: readonly Entry[], selected: number): GridPage<Entry> {
  const slots = tilesPerPage(layout, entries.length);
  const pages = Math.max(Math.ceil(entries.length / slots), 1);
  const page = Math.min(Math.floor(Math.max(selected, 0) / slots), pages - 1);
  const start = page * slots;
  const tiles = entries.slice(start, start + slots).map((entry, i) => ({ entry, position: start + i + 1 }));
  return { tiles, slots, page, pages };
}

/**
 * Columns and rows for `tiles` tiles in a `width` × `height` area: the shape in which the largest tile with the
 * `TILE_ASPECT` ratio that fits one cell is largest, and with a tie the one with fewer empty cells. Two tiles on a wide
 * screen sit side by side, six on an ultrawide in three columns and two rows.
 */
export function gridShape(tiles: number, width: number, height: number): { cols: number; rows: number } {
  let best = { cols: 1, rows: Math.max(tiles, 1), score: -1, empty: 0 };
  for (let cols = 1; cols <= Math.max(tiles, 1); cols++) {
    const rows = Math.ceil(Math.max(tiles, 1) / cols);
    const score = Math.min(width / cols / TILE_ASPECT, height / rows);
    const empty = cols * rows - tiles;
    if (score > best.score || (score === best.score && empty < best.empty)) best = { cols, rows, score, empty };
  }
  return { cols: best.cols, rows: best.rows };
}
