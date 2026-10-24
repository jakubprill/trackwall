import { useEffect, useRef } from "react";
import { type SessionShortcut, sessionShortcut } from "./session-shortcut.ts";

/**
 * Calls `onShortcut` for a session shortcut pressed anywhere in the window (ADR-48); it returns whether it handled
 * the shortcut. Like the view shortcuts, the listener runs in the capture phase and stops a handled event, so the key
 * does not also reach the session terminal, while an unhandled one (⌥1 typing `¡` in a text field) stays a key press.
 */
export function useSessionShortcuts(onShortcut: (shortcut: SessionShortcut) => boolean): void {
  const handler = useRef(onShortcut);
  handler.current = onShortcut;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const shortcut = sessionShortcut(event);
      if (!shortcut || !handler.current(shortcut)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, []);
}
