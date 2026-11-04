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

/** Whether the link is one: anything else opens nothing. `open` gets the link and its checked target. */
export function openTrackwallLink(url: string, open: (url: string, target: TrackwallLinkTarget) => void): boolean {
  const target = parseTrackwallLink(url);
  if (target) open(url, target);
  return target !== undefined;
}

/** How the page shows a link's target: `App`, which also takes the shell's jumps. */
export const ShowTrackwallTarget = createContext<((target: TrackwallLinkTarget) => void) | undefined>(undefined);

/** Opens a `trackwall://` link; true when it was one. */
export function useOpenTrackwallLink(): (url: string) => boolean {
  const show = useContext(ShowTrackwallTarget);
  return useCallback(
    (url: string) =>
      openTrackwallLink(url, (link, target) => {
        if (isTauri()) {
          invoke(OPEN_LINK_COMMAND, { url: link }).catch((err: unknown) => console.error("[jump] could not open the link", err));
        } else if (show) show(target);
        else console.error("[jump] nothing in this page shows a link's target", target);
      }),
    [show],
  );
}
