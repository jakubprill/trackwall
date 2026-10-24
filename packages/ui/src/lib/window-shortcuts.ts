/**
 * Keyboard shortcuts of the whole window (views, ADR-16; sessions, ADR-48). The listener runs in the capture phase on
 * `window` and stops a handled event there: xterm.js in a session terminal turns Ctrl + digit into a control character
 * and stops its propagation, so a listener in the bubble phase never sees it, and a shortcut must not also reach the
 * session. An event the handler does not take stays an ordinary key press.
 */
type ShortcutEvent = Pick<KeyboardEvent, "preventDefault" | "stopPropagation">;
type ShortcutTarget = Pick<Window, "addEventListener" | "removeEventListener">;

/** A keydown handler: `match` finds the shortcut, `handle` acts on it and says whether it took it. */
export function shortcutHandler<KeyEvent extends ShortcutEvent, Shortcut>(
  match: (event: KeyEvent) => Shortcut | undefined,
  handle: (shortcut: Shortcut) => boolean,
): (event: KeyEvent) => void {
  return (event) => {
    const shortcut = match(event);
    if (shortcut === undefined || !handle(shortcut)) return;
    event.preventDefault();
    event.stopPropagation();
  };
}

/** Listens for keydown in the capture phase; returns the function that stops listening. */
export function listenForShortcuts(target: ShortcutTarget, onKeyDown: (event: KeyboardEvent) => void): () => void {
  target.addEventListener("keydown", onKeyDown, { capture: true });
  return () => target.removeEventListener("keydown", onKeyDown, { capture: true });
}
