import { useCallback, useEffect, useRef, useState } from "react";
import {
  AWAY_KEY,
  type AwayPeriod,
  type PresenceMemory,
  pointerMoved,
  presenceSign,
  readAway,
  readLastActive,
  saveAway,
  saveLastActive,
} from "./away-presence.ts";

/** What counts as a sign of the user in a window (`away-presence.ts`), besides a pointer move and the window coming into view. */
const SIGNS = ["keydown", "pointerdown", "wheel", "focus"] as const;

const storage = () => window.localStorage;

/**
 * The open absence (ADR-151) and its dismissal: every sign of the user in this window checks the gap since the last
 * one in any window (`presenceSign`), and a change another window writes reaches this one through the `storage` event.
 */
export function useAway(): { away: AwayPeriod | undefined; dismiss: () => void } {
  const [away, setAway] = useState(() => readAway(storage));
  const memory = useRef<PresenceMemory>({ away, lastActive: readLastActive(storage), written: 0 });

  const show = useCallback((next: AwayPeriod | undefined) => {
    memory.current = { ...memory.current, away: next };
    setAway(next);
  }, []);

  useEffect(() => {
    const sign = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      const next = presenceSign(memory.current, now, () => ({ lastActive: readLastActive(storage), away: readAway(storage) }));
      memory.current = next.memory;
      if (next.write) saveLastActive(storage, now);
      if (next.opened) {
        saveAway(storage, next.opened);
        setAway(next.opened);
      }
    };
    let pointer: { x: number; y: number } | undefined;
    const move = (event: PointerEvent) => {
      if (!pointerMoved(pointer, event.screenX, event.screenY)) return;
      pointer = { x: event.screenX, y: event.screenY };
      sign();
    };
    const fromOtherWindow = (event: StorageEvent) => {
      if (event.key === AWAY_KEY || event.key === null) show(readAway(storage));
    };
    for (const name of SIGNS) window.addEventListener(name, sign, { passive: true });
    window.addEventListener("pointermove", move, { passive: true });
    document.addEventListener("visibilitychange", sign);
    window.addEventListener("storage", fromOtherWindow);
    return () => {
      for (const name of SIGNS) window.removeEventListener(name, sign);
      window.removeEventListener("pointermove", move);
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
