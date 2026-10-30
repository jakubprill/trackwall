import type { SessionList } from "@trackwall/protocol";
import { useEffect, useRef } from "react";
import { inDesktopShell } from "./app-window.ts";
import { showBrowserNotification } from "./browser-notifications.ts";
import { type BrowserNotice, TabAttention } from "./tab-attention.ts";
import { windowInFront } from "./window-focus.ts";

/**
 * In a browser tab, the count of what waits for you in the tab's title and a browser notification for each new wait
 * while the tab is not in front (ADR-146); clicking the notification brings the tab forward and opens what it names.
 * Nothing in the desktop app, whose shell does both (ADR-50).
 */
export function useTabAttention(list: SessionList | undefined, onOpen: (target: BrowserNotice["target"]) => void): void {
  const open = useRef(onOpen);
  open.current = onOpen;
  const attention = useRef(new TabAttention());

  useEffect(() => {
    if (inDesktopShell() || !list) return;
    const { title, notices } = attention.current.next(list, Date.now(), windowInFront(document));
    document.title = title;
    for (const notice of notices) {
      showBrowserNotification(notice, (target) => {
        window.focus();
        open.current(target);
      });
    }
  }, [list]);
}
