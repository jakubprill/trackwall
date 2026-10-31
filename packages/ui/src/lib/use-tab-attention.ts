import type { SessionList, TaskOutcome } from "@trackwall/protocol";
import { useCallback, useEffect, useRef } from "react";
import { inDesktopShell } from "./app-window.ts";
import { showBrowserNotification } from "./browser-notifications.ts";
import { type BrowserNotice, TabAttention } from "./tab-attention.ts";
import { PipelineFailures } from "./task-outcomes.ts";
import { windowInFront } from "./window-focus.ts";

/**
 * In a browser tab, the count of what waits for you in the tab's title and a browser notification for each new wait
 * while the tab is not in front (ADR-146), and one for a pipeline that failed (ADR-154); clicking the notification
 * brings the tab forward and opens what it names. Nothing in the desktop app, whose shell does both (ADR-50).
 */
export function useTabAttention(
  list: SessionList | undefined,
  outcomes: readonly TaskOutcome[] | undefined,
  onOpen: (target: BrowserNotice["target"]) => void,
): void {
  const open = useRef(onOpen);
  open.current = onOpen;
  const attention = useRef(new TabAttention());
  const failures = useRef(new PipelineFailures());
  const show = useCallback((notices: readonly BrowserNotice[]) => {
    for (const notice of notices) {
      showBrowserNotification(notice, (target) => {
        window.focus();
        open.current(target);
      });
    }
  }, []);

  useEffect(() => {
    if (inDesktopShell() || !list) return;
    const { title, notices } = attention.current.next(list, Date.now(), windowInFront(document));
    document.title = title;
    show(notices);
  }, [list, show]);

  useEffect(() => {
    if (inDesktopShell() || !outcomes) return;
    // Every list goes through, so a failure seen while the tab was in front is not announced later.
    const notices = failures.current.next(outcomes);
    if (!windowInFront(document)) show(notices);
  }, [outcomes, show]);
}
