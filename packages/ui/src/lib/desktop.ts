import { isTauri } from "@tauri-apps/api/core";
import { DAEMON_INFO_PATH, DaemonInfo, WebAddress, workspaceApi } from "@trackwall/protocol";
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
    call(conn, DAEMON_INFO_PATH, DaemonInfo).then(
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

const BLOCKED_TAB = "the browser blocked the new tab; allow pop-ups for this page";

/** Only an `http` or `https` address goes into a tab of this page (`WebAddress`). */
function webAddress(url: string): string {
  const parsed = WebAddress.safeParse(url);
  if (!parsed.success) throw new Error(`not a web address: ${url.slice(0, 80)}`);
  return parsed.data;
}

/** A web link opens through the daemon on its desktop, or in a new tab of this page when the daemon has none. */
export async function openWebLink(url: string, { desktop, viaDaemon, newTab }: WebLinkOpeners): Promise<void> {
  if (desktop) {
    await viaDaemon(url);
    return;
  }
  if (!newTab(webAddress(url))) throw new Error(BLOCKED_TAB);
}

/** A tab opened empty in the click, pointed at its address once the daemon gives it. */
export interface PendingTab {
  go: (url: string) => void;
  close: () => void;
}

/**
 * Opens a tab for an address the daemon has yet to give (the merge request form). A browser lets a page open a tab only
 * while it handles the click, and Safari not at all after an await, so the tab opens first and empty; a refusal closes it.
 */
export async function openInNewTabOnceKnown(address: () => Promise<string>, emptyTab: () => PendingTab | undefined): Promise<void> {
  const tab = emptyTab();
  if (!tab) throw new Error(BLOCKED_TAB);
  try {
    tab.go(webAddress(await address()));
  } catch (err) {
    tab.close();
    throw err;
  }
}

/** A new tab that cannot reach back into this page; `window.open` with `noopener` would always return `null`. */
function openInNewTab(url: string): boolean {
  const tab = window.open(url, "_blank");
  if (!tab) return false;
  tab.opener = null;
  return true;
}

export function openEmptyTab(): PendingTab | undefined {
  const tab = window.open("", "_blank");
  if (!tab) return undefined;
  tab.opener = null;
  return {
    go: (url) => {
      tab.location.href = url;
    },
    close: () => tab.close(),
  };
}

export function useOpenWebLink(conn: Connection): (url: string) => Promise<void> {
  const desktop = useDesktop();
  return useCallback(
    (url: string) =>
      openWebLink(url, { desktop, viaDaemon: (link) => post(conn, workspaceApi.openLink, { url: link }), newTab: openInNewTab }),
    [conn, desktop],
  );
}
