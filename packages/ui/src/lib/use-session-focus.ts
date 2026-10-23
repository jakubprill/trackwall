import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { SessionId } from "@trackwall/protocol";
import { useEffect, useRef } from "react";

/** Zdarzenie powłoki Tauri: użytkownik kliknął w trayu sesję, która czeka (ADR-24); niesie identyfikator sesji. */
export const FOCUS_SESSION_EVENT = "focus-session";

/** Wywołuje `onFocus` z identyfikatorem sesji, gdy powłoka prosi o pokazanie jej; poza oknem Tauri nic nie robi. */
export function useSessionFocus(onFocus: (session: string) => void): void {
  const handler = useRef(onFocus);
  handler.current = onFocus;
  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = listen<unknown>(FOCUS_SESSION_EVENT, (event) => {
      const session = SessionId.safeParse(event.payload);
      if (session.success) handler.current(session.data);
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);
}
