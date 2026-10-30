import type { SessionList } from "@trackwall/protocol";
import { useEffect, useRef } from "react";
import { inDesktopShell } from "./app-window.ts";
import { showBrowserNotification } from "./browser-notifications.ts";
import {
  type AttentionSnapshot,
  attentionNews,
  attentionSnapshot,
  ProposalBurst,
  sessionNotice,
  type TabNotice,
  tabTitle,
  waitingInTab,
} from "./tab-attention.ts";
import { windowInFront } from "./window-focus.ts";

/**
 * In a browser tab, the count of what waits for you in the tab's title and a browser notification for each new wait
 * while the tab is not in front (ADR-146); clicking the notification brings the tab forward and opens what it names.
 * Nothing in the desktop app, whose shell does both (ADR-50).
 */
export function useTabAttention(list: SessionList | undefined, onOpen: (target: TabNotice["target"]) => void): void {
  const open = useRef(onOpen);
  open.current = onOpen;
  const previous = useRef<AttentionSnapshot>(undefined);
  const burst = useRef(new ProposalBurst());

  useEffect(() => {
    if (inDesktopShell()) return;
    document.title = tabTitle(waitingInTab(list));
  }, [list]);

  useEffect(() => {
    if (inDesktopShell() || !list) return;
    const news = attentionNews(previous.current, list);
    previous.current = attentionSnapshot(list);
    // The burst learns of every proposal, also while the user looks, so a later one does not repeat them.
    const proposals = burst.current.add(news.proposals, list.proposals, Date.now());
    // The user looking at the tab sees the count and the session; a notification on top would only be noise.
    if (windowInFront(document)) return;
    for (const notice of [...news.sessions.map(sessionNotice), ...(proposals ? [proposals] : [])]) {
      showBrowserNotification(notice, (target) => {
        window.focus();
        open.current(target);
      });
    }
  }, [list]);
}
