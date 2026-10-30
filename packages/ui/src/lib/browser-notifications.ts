import { useSyncExternalStore } from "react";
import type { TabNotice } from "./tab-attention.ts";

/**
 * Browser notifications of a Trackwall page in a browser tab (ADR-146): whether the browser lets the page show them,
 * asking for that, which a browser allows only in a click, and showing one. The desktop app shows system notifications
 * from its shell instead (ADR-50) and never asks here.
 */
export type NotificationAccess = NotificationPermission | "unsupported";

function notificationAccess(): NotificationAccess {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

// One store for the page, so the offer above the views and the section in Settings change together.
const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) listener();
};
let watchingPermission = false;

/** The user can also allow or block the page in the browser's site settings, which the Permissions API reports. */
function watchPermission(): void {
  if (watchingPermission || typeof navigator === "undefined" || !navigator.permissions) return;
  watchingPermission = true;
  navigator.permissions.query({ name: "notifications" }).then(
    (status) => status.addEventListener("change", changed),
    () => {
      // Without the API a change in the site settings shows after a reload.
    },
  );
}

function subscribe(listener: () => void): () => void {
  watchPermission();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Call only from a click handler: a browser ignores or blocks a request the user did not start. */
export async function askForNotifications(): Promise<NotificationAccess> {
  if (notificationAccess() === "unsupported") return "unsupported";
  await Notification.requestPermission();
  changed();
  return notificationAccess();
}

export function useNotificationAccess(): NotificationAccess {
  return useSyncExternalStore(subscribe, notificationAccess);
}

/** Shows the notice when the page may; clicking it closes it and hands its target on. */
export function showBrowserNotification(notice: TabNotice, onClick: (target: TabNotice["target"]) => void): void {
  if (notificationAccess() !== "granted") return;
  try {
    const shown = new Notification(notice.title, { body: notice.body, tag: notice.tag, icon: "/favicon.png" });
    shown.onclick = () => {
      shown.close();
      onClick(notice.target);
    };
  } catch (err) {
    // Some browsers (Chrome on Android) show notifications only from a service worker; the title still counts.
    console.error("[notifications] the browser did not show a notification", err);
  }
}
