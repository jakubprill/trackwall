import { isTauri } from "@tauri-apps/api/core";
import { DaemonInfo, workspaceApi } from "@trackwall/protocol";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { call, post } from "./api.ts";
import type { Connection } from "./connection.ts";

/**
 * Whether the daemon opens links, folders and VS Code on this computer (`DaemonInfo.desktop`, ADR-120). A daemon in a
 * container has no desktop: this page then opens web links in a new tab itself, and the buttons that open a folder or
 * VS Code are hidden. `true` until the daemon says otherwise, since the Tauri window always runs next to its own daemon.
 */
export const DesktopContext = createContext(true);

/** Why the buttons that open a folder or VS Code are not there. */
export const NO_DESKTOP_NOTE =
  "Trackwall runs without a desktop here (for example in a container), so it opens no folders or VS Code on your computer.";

export function useDesktop(): boolean {
  return useContext(DesktopContext);
}

/** Asks the daemon once whether it has a desktop; only a page in a browser can be looking at a daemon in a container. */
export function useDaemonDesktop(conn: Connection | undefined): boolean {
  const [desktop, setDesktop] = useState(true);
  useEffect(() => {
    if (!conn || isTauri()) return;
    // Without an answer the page behaves as before: the daemon opens links and says no_desktop when it cannot.
    call(conn, "/api/daemon/info", DaemonInfo).then(
      (info) => setDesktop(info.desktop),
      () => {},
    );
  }, [conn]);
  return desktop;
}

export interface WebLinkOpeners {
  desktop: boolean;
  /** The daemon opens the link in the system browser (`open-link`). */
  viaDaemon: (url: string) => Promise<unknown>;
  /** Opens the link in a new tab of this page; `false` when the browser blocked it. */
  newTab: (url: string) => boolean;
}

/** A web link opens through the daemon on its desktop, or in a new tab of this page when the daemon has none. */
export async function openWebLink(url: string, { desktop, viaDaemon, newTab }: WebLinkOpeners): Promise<void> {
  if (desktop) {
    await viaDaemon(url);
    return;
  }
  if (!newTab(url)) throw new Error("the browser blocked the new tab; allow pop-ups for this page");
}

/** A new tab that cannot reach back into this page; `window.open` with `noopener` would always return `null`. */
export function openInNewTab(url: string): boolean {
  const tab = window.open(url, "_blank");
  if (!tab) return false;
  tab.opener = null;
  return true;
}

export function useOpenWebLink(conn: Connection): (url: string) => Promise<void> {
  const desktop = useDesktop();
  return useCallback(
    (url: string) =>
      openWebLink(url, { desktop, viaDaemon: (link) => post(conn, workspaceApi.openLink, { url: link }), newTab: openInNewTab }),
    [conn, desktop],
  );
}
