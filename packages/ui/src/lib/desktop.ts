import { invoke, isTauri } from "@tauri-apps/api/core";
import { type ContainerId, containerEditorUrl, DAEMON_INFO_PATH, DaemonInfo, WebAddress, workspaceApi } from "@trackwall/protocol";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { call, post } from "./api.ts";
import type { Connection } from "./connection.ts";

/**
 * Where the daemon runs, from its info: whether it opens links, folders and VS Code on this computer
 * (`DaemonInfo.desktop`, ADR-120) and the container it runs in (ADR-121). A daemon in a container has no desktop: this
 * page then opens web links in a new tab itself, VS Code opens attached to the container, and the buttons that open a
 * folder are hidden. The desktop app can use such a daemon too (ADR-130): it then opens web links and VS Code itself.
 * A desktop until the daemon says otherwise.
 */
export interface DaemonPlace {
  desktop: boolean;
  container: ContainerId | null;
}

const ON_A_DESKTOP: DaemonPlace = { desktop: true, container: null };

export const DaemonPlaceContext = createContext(ON_A_DESKTOP);

/** Why the buttons that open a folder or VS Code are not there. */
export const NO_DESKTOP_NOTE =
  "Trackwall runs without a desktop here (for example in a container), so it opens no folders or VS Code on your computer.";

/** Why only VS Code opens, and how. */
export const IN_CONTAINER_NOTE =
  "Trackwall runs in a container: VS Code opens files and folders inside it with the Dev Containers extension, and no file manager can show them.";

export function useDesktop(): boolean {
  return useContext(DaemonPlaceContext).desktop;
}

/**
 * The address that opens a folder or file in VS Code from this page, when the daemon cannot open it itself: inside the
 * daemon's container (ADR-121). `undefined` when the daemon opens it, or when nothing can.
 */
export function editorLinkFor(place: DaemonPlace, path: string): string | undefined {
  if (place.desktop || !place.container) return undefined;
  return containerEditorUrl(place.container, path);
}

export function useEditorLink(path: string): string | undefined {
  return editorLinkFor(useContext(DaemonPlaceContext), path);
}

/** Asks the daemon once where it runs. */
export function useDaemonPlace(conn: Connection | undefined): DaemonPlace {
  const [place, setPlace] = useState(ON_A_DESKTOP);
  useEffect(() => {
    if (!conn) return;
    // Without an answer the page behaves as before: the daemon opens links and says no_desktop when it cannot.
    call(conn, DAEMON_INFO_PATH, DaemonInfo).then(
      (info) => setPlace({ desktop: info.desktop, container: info.container }),
      () => {},
    );
  }, [conn]);
  return place;
}

export interface WebLinkOpeners {
  desktop: boolean;
  /** The daemon opens the link in the system browser (`open-link`). */
  viaDaemon: (url: string) => Promise<unknown>;
  /**
   * Opens the link in a new tab of this page; `false` when the browser blocked it. In the desktop app, which opens no
   * tabs, the window hands it to the system browser instead and resolves once it has.
   */
  newTab: (url: string) => boolean | Promise<void>;
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
  const opened = newTab(webAddress(url));
  if (opened === false) throw new Error(BLOCKED_TAB);
  if (opened !== true) await opened;
}

/** The shell command that opens a web page or VS Code attached to a container (`system_open.rs`). */
const OPEN_OUTSIDE_COMMAND = "open_outside";

/** The desktop app hands an address to the system itself, since its daemon may have no desktop (ADR-130). */
export function openOutside(url: string): Promise<void> {
  return invoke(OPEN_OUTSIDE_COMMAND, { url });
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
  // The desktop app has no tabs to open in the click: the address goes to the system browser once known.
  if (isTauri()) {
    return {
      go: (url) => {
        openOutside(url).catch((err: unknown) => console.error("[link] could not open the address", err));
      },
      close: () => {},
    };
  }
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
      openWebLink(url, {
        desktop,
        viaDaemon: (link) => post(conn, workspaceApi.openLink, { url: link }),
        newTab: isTauri() ? openOutside : openInNewTab,
      }),
    [conn, desktop],
  );
}
