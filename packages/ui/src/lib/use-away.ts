import { useCallback, useEffect, useRef, useState } from "react";
import {
  AWAY_KEY,
  type AwayPeriod,
  absenceAt,
  PRESENCE_WRITE_MS,
  readAway,
  readLastActive,
  saveAway,
  saveLastActive,
} from "./away-presence.ts";

/** What counts as a sign of the user in a window (`away-presence.ts`); a pointer move is one, so reading with the mouse is too. */
const SIGNS = ["keydown", "pointerdown", "pointermove", "wheel", "focus"] as const;

const storage = () => window.localStorage;

/**
 * The open absence (ADR-151) and its dismissal: every sign of the user in this window checks the gap since the last
 * one in any window, and a change another window writes reaches this one through the `storage` event.
 */
export function useAway(): { away: AwayPeriod | undefined; dismiss: () => void } {
  const [away, setAway] = useState(() => readAway(storage));
  // This window's own memory, for when storage is missing; the storage, when there is one, is shared and wins.
  const memory = useRef<{ away: AwayPeriod | undefined; lastActive: number | undefined; written: number }>({
    away,
    lastActive: readLastActive(storage),
    written: 0,
  });

  const show = useCallback((next: AwayPeriod | undefined) => {
    memory.current.away = next;
    setAway(next);
  }, []);

  useEffect(() => {
    const sign = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      const m = memory.current;
      const lastActive = latest(m.lastActive, readLastActive(storage));
      const opened = absenceAt(lastActive, now, readAway(storage) ?? m.away);
      m.lastActive = now;
      if (opened) {
        saveAway(storage, opened);
        show(opened);
      }
      if (opened || now - m.written >= PRESENCE_WRITE_MS) {
        saveLastActive(storage, now);
        m.written = now;
      }
    };
    const fromOtherWindow = (event: StorageEvent) => {
      if (event.key === AWAY_KEY || event.key === null) show(readAway(storage));
    };
    for (const name of SIGNS) window.addEventListener(name, sign, { passive: true });
    document.addEventListener("visibilitychange", sign);
    window.addEventListener("storage", fromOtherWindow);
    return () => {
      for (const name of SIGNS) window.removeEventListener(name, sign);
      document.removeEventListener("visibilitychange", sign);
      window.removeEventListener("storage", fromOtherWindow);
    };
  }, [show]);

  const dismiss = useCallback(() => {
    saveAway(storage, undefined);
    show(undefined);
  }, [show]);
  return { away, dismiss };
}

function latest(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  return b === undefined ? a : Math.max(a, b);
}
