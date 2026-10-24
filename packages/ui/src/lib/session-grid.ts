/**
 * The layout of the Sessions view (ADR-48): one session with its full panel, or a grid of session terminals. Layouts 2
 * and 4 split the list into pages of that many entries and show the page with the focused entry, so a shortcut to any
 * position also turns the page. Auto shows every entry at once, up to `MAX_TILES`, on as many pages as needed.
 */
export const SESSION_LAYOUTS = ["1", "2", "4", "auto"] as const;
export type SessionLayout = (typeof SESSION_LAYOUTS)[number];

/** Nine Copilot CLI terminals in three columns still have over 100 columns each on a 34-inch ultrawide screen (3440 px). */
const MAX_TILES = 9;

/** Width to height of the tile the shape tries to make as large as possible; a terminal reads better wide than tall. */
const TILE_ASPECT = 1.6;

export interface GridPage {
  /** Index of the page's first entry in the list. */
  start: number;
  /** How many entries the page shows; the last page can show fewer than a full page. */
  count: number;
  page: number;
  pages: number;
}

/** Tiles on one page; Auto fits the whole list, at least one tile so that an empty list still has a page. */
export function tilesPerPage(layout: SessionLayout, entries: number): number {
  if (layout === "auto") return Math.min(Math.max(entries, 1), MAX_TILES);
  return Number(layout);
}

/** The page with the focused entry; with no focused entry (−1) the first page. */
export function gridPage(layout: SessionLayout, entries: number, focused: number): GridPage {
  const size = tilesPerPage(layout, entries);
  const pages = Math.max(Math.ceil(entries / size), 1);
  const page = Math.min(Math.floor(Math.max(focused, 0) / size), pages - 1);
  const start = page * size;
  return { start, count: Math.max(Math.min(size, entries - start), 0), page, pages };
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
