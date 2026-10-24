import { useEffect, useRef } from "react";
import { listenForShortcuts, shortcutHandler } from "./window-shortcuts.ts";

/** Window shortcuts (`window-shortcuts.ts`) for a component; the latest `match` and `handle` are used. */
export function useWindowShortcuts<Shortcut>(
  match: (event: KeyboardEvent) => Shortcut | undefined,
  handle: (shortcut: Shortcut) => boolean,
): void {
  const callbacks = useRef({ match, handle });
  callbacks.current = { match, handle };
  useEffect(
    () =>
      listenForShortcuts(
        window,
        shortcutHandler(
          (event: KeyboardEvent) => callbacks.current.match(event),
          (shortcut: Shortcut) => callbacks.current.handle(shortcut),
        ),
      ),
    [],
  );
}
