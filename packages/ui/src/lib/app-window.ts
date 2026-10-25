import { invoke, isTauri } from "@tauri-apps/api/core";
import { Menu } from "@tauri-apps/api/menu";

/**
 * Trackwall windows (ADR-49): every window of the desktop shell is the same UI with its own view. An extra window
 * starts with the view and session layout from the query parameters of its page (`window_url` in
 * `apps/desktop/src-tauri/src/windows.rs`), and tells the shell what it shows, so that a session from the tray opens
 * in a window that already shows Sessions and the next start opens the window again with the same view. Outside the
 * shell (the UI served by the daemon) there is one window.
 */
export const START_PARAMS = { view: "view", sessionLayout: "sessionLayout" } as const;

/** A value a window starts with, from its page address; `undefined` for the main window or an unknown value. */
export function startFromLocation<Value extends string>(search: string, param: string, values: readonly Value[]): Value | undefined {
  const requested = new URLSearchParams(search).get(param);
  return values.find((value) => value === requested);
}

/** Only the desktop shell has windows to open and a registry to report to. */
export function inDesktopShell(): boolean {
  return isTauri();
}

/** Opens a new window with the view; on another monitor it is the window that was there last time. */
export function openWindow(view: string): Promise<void> {
  return invoke("open_window", { view });
}

/** Tells the shell what this window shows, with the view's name for the window title; does nothing outside the shell. */
export function reportShown(view: string, viewName: string, sessionLayout: string): Promise<void> {
  return inDesktopShell() ? invoke("window_shows", { view, viewName, sessionLayout }) : Promise.resolve();
}

// One native menu per window, reused for every right click (see `showViewMenu`).
let viewMenu: Promise<Menu> | undefined;
let openFromMenu: (() => void) | undefined;

/**
 * The native context menu of a view icon on the activity bar. The menu is reused, because each `Menu.new` stays in
 * the window's resources until it closes, and a failed one is created again on the next right click; the item has a
 * generated id, because menu item ids are shared by all windows of the app.
 */
export async function showViewMenu(openInNewWindow: () => void): Promise<void> {
  openFromMenu = openInNewWindow;
  viewMenu ??= Menu.new({ items: [{ text: "Open in new window", action: () => openFromMenu?.() }] }).catch((err: unknown) => {
    viewMenu = undefined;
    throw err;
  });
  await (await viewMenu).popup();
}
