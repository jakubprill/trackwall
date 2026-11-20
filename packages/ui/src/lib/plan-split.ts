/**
 * How Plan shares its width between the list in the middle and the selected item or entry on the right (ADR-285). The
 * split is a share of that width, not pixels, so it reads the same on a laptop and on a wide screen; it is clamped so that
 * neither side gets too narrow to read, and the list keeps its minimum first. A display preference of this computer, like
 * the theme, so it lives in `localStorage`, read and written without ever failing: anything but a share in range reads as
 * the default.
 */

/** The `localStorage` key of the panel's share. */
export const PLAN_SPLIT_KEY = "trackwall.plan.panelShare";

/** Half and half: the item's notes are what the user reads, the list needs less than its full width. */
export const DEFAULT_PANEL_SHARE = 0.5;

/** The narrowest the list gets, in pixels: a title, its column and the fold arrow on one row. */
export const LIST_MIN_PX = 288;

/** The narrowest the panel gets, in pixels: the width the right column always had (24rem at 16px). */
export const PANEL_MIN_PX = 384;

/** One press of ← or → on the divider. */
export const PANEL_SHARE_STEP = 0.05;

const SHARE_MIN = 0.1;
const SHARE_MAX = 0.9;

/** A share kept between the bounds any width can use, so a stored or dragged value never hides a side for good. */
export function clampShare(share: number): number {
  if (!Number.isFinite(share)) return DEFAULT_PANEL_SHARE;
  return Math.min(SHARE_MAX, Math.max(SHARE_MIN, share));
}

/**
 * The panel's width in pixels for the width the list and the panel share. The list keeps `LIST_MIN_PX` first; when the
 * area cannot hold both minimums, the panel gets what is left.
 */
export function panelWidth(area: number, share: number): number {
  const wanted = Math.round(area * clampShare(share));
  const most = Math.max(0, area - LIST_MIN_PX);
  return Math.min(most, Math.max(PANEL_MIN_PX, wanted));
}

/** The share that puts the divider at `x` pixels from the area's left edge (the list's left edge). */
export function shareAt(area: number, x: number): number {
  if (area <= 0) return DEFAULT_PANEL_SHARE;
  return clampShare((area - x) / area);
}

export function readPanelShare(storage: () => Pick<Storage, "getItem">): number {
  try {
    const stored = storage().getItem(PLAN_SPLIT_KEY);
    const share = stored === null ? Number.NaN : Number(stored);
    return share >= SHARE_MIN && share <= SHARE_MAX ? share : DEFAULT_PANEL_SHARE;
  } catch {
    return DEFAULT_PANEL_SHARE;
  }
}

export function savePanelShare(storage: () => Pick<Storage, "setItem">, share: number): void {
  try {
    storage().setItem(PLAN_SPLIT_KEY, String(clampShare(share)));
  } catch {
    // The split holds until the window closes; only the next start does not remember it.
  }
}
