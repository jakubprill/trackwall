import { invoke, isTauri } from "@tauri-apps/api/core";
import { Menu } from "@tauri-apps/api/menu";

/**
 * Trackwall windows (ADR-49): every window of the desktop shell is the same UI with its own view. An extra window
 * starts with the view from the `view` query parameter of its page (`window_url` in
 * `apps/desktop/src-tauri/src/windows.rs`), and tells the shell whether it shows Sessions, so that a session from the
 * tray opens in a window that already shows them. Outside the shell (the UI served by the daemon) there is one window.
 */
const VIEW_PARAM = "view";

/** The view a window starts with, from its page address; `undefined` for the main window or an unknown view. */
export function viewFromLocation<View extends string>(search: string, views: readonly View[]): View | undefined {
  const requested = new URLSearchParams(search).get(VIEW_PARAM);
  return views.find((view) => view === requested);
}

/** Only the desktop shell opens windows. */
export function canOpenWindows(): boolean {
  return isTauri();
}

/** Opens a new window with the view; on another monitor it is the window that was there last time. */
export function openWindow(view: string): Promise<void> {
  return invoke("open_window", { view });
}

/** Tells the shell whether this window shows the Sessions view; does nothing outside the shell. */
export function reportShowsSessions(shows: boolean): Promise<void> {
  return isTauri() ? invoke("window_shows_sessions", { shows }) : Promise.resolve();
}

/** The native context menu of a view icon on the activity bar. */
export async function showViewMenu(openInNewWindow: () => void): Promise<void> {
  const menu = await Menu.new({ items: [{ id: "open-in-new-window", text: "Open in new window", action: openInNewWindow }] });
  await menu.popup();
}
