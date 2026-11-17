/**
 * The height a part of a view had the last time it showed its data (ADR-264), kept so that the part can hold that height
 * while it loads again and what stands under it does not jump when the data comes. A convenience of this browser
 * profile in `localStorage`, like the Home scene's settings: storage can be missing, refuse access or hold anything, so
 * a value that is not a plausible height reads as none, and a write that fails is forgotten.
 */

const KEY_PREFIX = "trackwall.height.";

/** Taller than any part that loads; a larger stored value is a mistake, not a height to hold. */
const MAX_HEIGHT = 5000;

export function readSteadyHeight(storage: () => Pick<Storage, "getItem">, name: string): number | null {
  try {
    const stored = storage().getItem(KEY_PREFIX + name);
    const height = stored === null ? Number.NaN : Number(stored);
    return Number.isInteger(height) && height > 0 && height <= MAX_HEIGHT ? height : null;
  } catch {
    return null;
  }
}

export function saveSteadyHeight(storage: () => Pick<Storage, "setItem">, name: string, height: number): void {
  try {
    storage().setItem(KEY_PREFIX + name, String(Math.round(height)));
  } catch {
    // The part keeps its height until the window closes; only the next start shows the placeholder's own height.
  }
}
