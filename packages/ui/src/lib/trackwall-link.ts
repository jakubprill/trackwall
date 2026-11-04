import { invoke, isTauri } from "@tauri-apps/api/core";
import { parseTrackwallLink, type TrackwallLinkTarget } from "@trackwall/protocol";
import { createContext, useCallback, useContext } from "react";

/**
 * Opening a `trackwall://` link clicked in this page (ADR-52): in an agent's answer in the conversation view, in a
 * README, in a session terminal. In the desktop app the shell opens it (`open_link` in
 * `apps/desktop/src-tauri/src/link.rs`), because it knows which window shows sessions (ADR-49); in a browser tab
 * there is no shell, so the page shows the target itself, the way it takes a jump from the shell. Either way the link is
 * checked first (`parseTrackwallLink`), and a link only switches the view.
 */
const OPEN_LINK_COMMAND = "open_link";

export interface TrackwallLinkOpeners {
  inShell: boolean;
  viaShell: (url: string) => Promise<void>;
  inPage: (target: TrackwallLinkTarget) => void;
}

/** Whether the link is one: anything else opens nothing. */
export function openTrackwallLink(url: string, { inShell, viaShell, inPage }: TrackwallLinkOpeners): boolean {
  const target = parseTrackwallLink(url);
  if (!target) return false;
  if (!inShell) {
    inPage(target);
    return true;
  }
  viaShell(url).catch((err: unknown) => console.error("[jump] could not open the link", err));
  return true;
}

/** How the page shows a link's target: `App`, which also takes the shell's jumps. */
export const ShowTrackwallTarget = createContext<((target: TrackwallLinkTarget) => void) | undefined>(undefined);

/** Opens a `trackwall://` link; true when it was one. */
export function useOpenTrackwallLink(): (url: string) => boolean {
  const show = useContext(ShowTrackwallTarget);
  return useCallback(
    (url: string) =>
      openTrackwallLink(url, {
        inShell: isTauri(),
        viaShell: (link) => invoke(OPEN_LINK_COMMAND, { url: link }),
        inPage: (target) => {
          if (show) show(target);
          else console.error("[jump] nothing in this page shows a link's target", target);
        },
      }),
    [show],
  );
}
