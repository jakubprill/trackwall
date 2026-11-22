import { knownValue } from "./known-value.ts";

/**
 * Whether Home has an icon on the view bar (ADR-294). Since "Repos" opens on "All repos" (ADR-293) and the Sessions list
 * closes the tasks ready to close, nothing waits for the user only on Home, so the bar leaves it out until the user shows
 * it in Settings › App; its shortcut, the command palette and the menu bar open it either way. A display preference of
 * this computer, like the Home scene's look (ADR-104), so it lives in `localStorage`, which every window of the desktop
 * shell shares. Storage can be missing, refuse access or hold a value from a newer version, so anything but a known
 * value reads as hidden, and a write that fails is forgotten.
 */
const HOME_ON_BAR = ["shown", "hidden"] as const;
export type HomeOnBar = (typeof HOME_ON_BAR)[number];

/** The `localStorage` key; the `storage` event carries it to the other windows. */
export const HOME_ON_BAR_KEY = "trackwall.home.bar";

export function readHomeOnBar(storage: () => Pick<Storage, "getItem">): HomeOnBar {
  try {
    return knownValue(HOME_ON_BAR, storage().getItem(HOME_ON_BAR_KEY)) ?? "hidden";
  } catch {
    return "hidden";
  }
}

export function saveHomeOnBar(storage: () => Pick<Storage, "setItem">, value: HomeOnBar): void {
  try {
    storage().setItem(HOME_ON_BAR_KEY, value);
  } catch {
    // The bar keeps the choice until the window closes; only the next start does not remember it.
  }
}
