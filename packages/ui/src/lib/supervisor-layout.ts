/**
 * How the supervisor panel (ADR-58) sits on the right: folded to a narrow strip, pinned open in a column next to the
 * view, or wide, a column that leaves the view a narrow part of the window, for reading the supervisor's answers. A
 * convenience of this browser profile, kept in `localStorage`. Storage can be missing or refuse access (a private
 * window, blocked site data), so a failure reads as the default and a write that fails is forgotten.
 */
const LAYOUTS = ["folded", "pinned", "wide"] as const;
export type SupervisorLayout = (typeof LAYOUTS)[number];

/**
 * The key and the values "true" and "false" are the ones of the time the panel could only be pinned or folded, so a
 * choice made then survives.
 */
const LAYOUT_KEY = "trackwall.supervisor.pinned";
const STORED: Record<SupervisorLayout, string> = { folded: "false", pinned: "true", wide: "wide" };

/** Pinned until the user folds it: the supervisor is the first thing to talk to. */
export function readSupervisorLayout(storage: () => Pick<Storage, "getItem">): SupervisorLayout {
  try {
    const stored = storage().getItem(LAYOUT_KEY);
    return LAYOUTS.find((layout) => STORED[layout] === stored) ?? "pinned";
  } catch {
    return "pinned";
  }
}

export function saveSupervisorLayout(storage: () => Pick<Storage, "setItem">, layout: SupervisorLayout): void {
  try {
    storage().setItem(LAYOUT_KEY, STORED[layout]);
  } catch {
    // The panel still changes in this window; only the next start does not remember it.
  }
}

/** Showing the supervisor unfolds a folded panel and keeps a wide one wide. */
export function unfolded(layout: SupervisorLayout): SupervisorLayout {
  return layout === "folded" ? "pinned" : layout;
}

/** The header's Widen and Narrow button: a wide panel goes back to pinned, a pinned one goes wide. */
export function widenedOrNarrowed(layout: SupervisorLayout): SupervisorLayout {
  return layout === "wide" ? "pinned" : "wide";
}
