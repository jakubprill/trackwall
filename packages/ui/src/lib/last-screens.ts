import { createContext, useContext } from "react";

/**
 * The screen a session terminal showed when it closed, kept per session in the window (ADR-117). A terminal that opens
 * again (back from another view, another session selected, the grid) shows it at once instead of a black frame, until
 * the daemon's screen image replaces it: where the daemon answers late, the image comes seconds later.
 */

/** A screen as xterm.js's serializer gives it, with the width it was taken in. */
export interface LastScreen {
  cols: number;
  screen: string;
}

/** More sessions than a day brings: the oldest screen goes first, so a long-running window does not keep them all. */
const MAX_SCREENS = 50;

export class LastScreens {
  readonly #screens = new Map<string, LastScreen>();

  keep(session: string, screen: LastScreen): void {
    this.#screens.delete(session);
    this.#screens.set(session, screen);
    for (const oldest of this.#screens.keys()) {
      if (this.#screens.size <= MAX_SCREENS) break;
      this.#screens.delete(oldest);
    }
  }

  /**
   * The kept screen when it was taken in this width; in another one its lines would wrap into a garbled frame. A
   * different height only moves it by a row or two: a terminal that opens may be a row short until the layout settles.
   */
  shown(session: string, cols: number): string | undefined {
    const kept = this.#screens.get(session);
    return kept?.cols === cols ? kept.screen : undefined;
  }
}

/** The main window's screens, which `main.tsx` provides around `App`. */
export const LastScreensContext = createContext<LastScreens | null>(null);

export function useLastScreens(): LastScreens {
  const screens = useContext(LastScreensContext);
  if (screens === null) throw new Error("a session terminal outside the main window: no LastScreensContext above it");
  return screens;
}
