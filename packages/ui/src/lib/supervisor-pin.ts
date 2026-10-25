/**
 * Whether the supervisor panel (ADR-58) is pinned open on the right or folded to a narrow strip: a convenience of this
 * browser profile, kept in `localStorage`. Storage can be missing or refuse access (a private window, blocked site
 * data), so a failure reads as the default and a write that fails is forgotten.
 */
const PIN_KEY = "trackwall.supervisor.pinned";

/** Pinned until the user folds it: the supervisor is the first thing to talk to. */
export function readSupervisorPinned(storage: () => Pick<Storage, "getItem">): boolean {
  try {
    return storage().getItem(PIN_KEY) !== "false";
  } catch {
    return true;
  }
}

export function saveSupervisorPinned(storage: () => Pick<Storage, "setItem">, pinned: boolean): void {
  try {
    storage().setItem(PIN_KEY, String(pinned));
  } catch {
    // The panel still folds and unfolds in this window; only the next start does not remember it.
  }
}
