/**
 * How many steps "Get started" had open the last time the doctor ran (ADR-268), kept so that Settings can say it and
 * open on "Get started" before the doctor has run again: the doctor opens connections and times file writes, so it runs
 * only when one of its two categories shows. A convenience of this browser profile in `localStorage`, like the heights
 * of ADR-264: storage can be missing, refuse access or hold anything, so a value that is no count reads as unknown, and
 * a write that fails is forgotten.
 */

const KEY = "trackwall.get-started.open";

/** More steps than "Get started" can have; a larger stored value is a mistake, not a count. */
const MAX_STEPS = 100;

/** The remembered count, `null` while the doctor never ran in this browser profile. */
export function readOpenSteps(storage: () => Pick<Storage, "getItem">): number | null {
  try {
    const stored = storage().getItem(KEY);
    const count = stored === null ? Number.NaN : Number(stored);
    return Number.isInteger(count) && count >= 0 && count <= MAX_STEPS ? count : null;
  } catch {
    return null;
  }
}

export function saveOpenSteps(storage: () => Pick<Storage, "setItem">, count: number): void {
  try {
    storage().setItem(KEY, String(count));
  } catch {
    // The count holds while Settings is open; the next opening only does not know it until the doctor runs.
  }
}
