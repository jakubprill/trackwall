/**
 * Tab shortcuts (ADR-211): the next or previous tab of the tab bar in a view's content, like the tabs of a browser, so
 * that a task's Terminal and Shell are one key apart. Ctrl+PageDown and Ctrl+PageUp everywhere; on macOS also ⌘⇧] and
 * ⌘⇧[, because a Mac keyboard has no Page keys (fn + arrow). Copilot CLI uses PageUp and PageDown alone to scroll its
 * timeline and has no binding with Ctrl, and ⌘ never reaches a terminal, so neither takes a key from the session. The
 * brackets go by position (`code`), because Shift turns them into braces and other layouts put other characters there.
 * Ctrl+Shift+PageUp, which moves a tab in a browser, stays a key.
 */
export type TabStep = "next" | "previous";

type KeyPress = Pick<KeyboardEvent, "code" | "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">;

export function tabShortcut(press: KeyPress, isMac: boolean): TabStep | undefined {
  if (press.altKey) return undefined;
  if (press.ctrlKey && !press.metaKey && !press.shiftKey) return pageStep(press.key);
  if (isMac && press.metaKey && press.shiftKey && !press.ctrlKey) return bracketStep(press.code);
  return undefined;
}

function pageStep(key: string): TabStep | undefined {
  if (key === "PageDown") return "next";
  if (key === "PageUp") return "previous";
  return undefined;
}

function bracketStep(code: string): TabStep | undefined {
  if (code === "BracketRight") return "next";
  if (code === "BracketLeft") return "previous";
  return undefined;
}

/** The tab one step from the active one, wrapping around at both ends like a browser; the active one when it is not listed. */
export function steppedTab<Id extends string>(tabs: readonly { id: Id }[], active: Id, step: TabStep): Id {
  const at = tabs.findIndex((tab) => tab.id === active);
  if (at === -1) return active;
  const next = (at + (step === "next" ? 1 : -1) + tabs.length) % tabs.length;
  const tab = tabs[next];
  if (tab === undefined) throw new Error(`No tab at ${next} of ${tabs.length}`);
  return tab.id;
}

/** The shortcut caption in the system's convention. */
export function tabShortcutLabel(isMac: boolean): string {
  return isMac ? "⌘⇧] / ⌘⇧[" : "Ctrl+PageDown / Ctrl+PageUp";
}
