import type { NotificationAccess } from "./browser-notifications.ts";

/**
 * The offer above the views to turn browser notifications on (ADR-146): shown in a browser tab while the browser has not
 * been asked yet, until the user turns them on or says "Not now". "Not now" is a convenience of this browser profile,
 * kept in `localStorage`; Settings › App still turns them on. Storage can be missing or refuse access (a private
 * window, blocked site data), so a failure reads as not dismissed and a write that fails is forgotten.
 */
const DISMISSED_KEY = "trackwall.browser-notifications.offer-dismissed";

export function readOfferDismissed(storage: () => Pick<Storage, "getItem">): boolean {
  try {
    return storage().getItem(DISMISSED_KEY) === "true";
  } catch {
    return false;
  }
}

export function saveOfferDismissed(storage: () => Pick<Storage, "setItem">): void {
  try {
    storage().setItem(DISMISSED_KEY, "true");
  } catch {
    // The offer goes away in this tab; only the next one shows it again.
  }
}

/** Only the browser, and only before it was asked: once allowed or blocked, the browser does not ask again. */
export function showsNotificationOffer(inDesktopShell: boolean, access: NotificationAccess, dismissed: boolean): boolean {
  return !inDesktopShell && access === "default" && !dismissed;
}
