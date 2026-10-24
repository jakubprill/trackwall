import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { SessionId, TaskId } from "@trackwall/protocol";
import { useEffect, useRef } from "react";
import type { SessionSelection } from "./session-entries.ts";

/**
 * Zdarzenia powłoki Tauri: użytkownik kliknął w trayu sesję, która czeka (ADR-26), albo propozycję zadania (ADR-39).
 * Niosą identyfikator sesji albo propozycji; nazwy są też w `apps/desktop/src-tauri/src/attention.rs`.
 */
const FOCUS_SESSION_EVENT = "focus-session";
const FOCUS_PROPOSAL_EVENT = "focus-proposal";

/** Wywołuje `onFocus` z pozycją widoku „Sessions”, gdy powłoka prosi o pokazanie jej; poza oknem Tauri nic nie robi. */
export function useSessionFocus(onFocus: (selection: SessionSelection) => void): void {
  const handler = useRef(onFocus);
  handler.current = onFocus;
  useEffect(() => {
    if (!isTauri()) return;
    const stops = [
      listen<unknown>(FOCUS_SESSION_EVENT, (event) => {
        const session = SessionId.safeParse(event.payload);
        if (session.success) handler.current({ kind: "session", id: session.data });
      }),
      listen<unknown>(FOCUS_PROPOSAL_EVENT, (event) => {
        const proposal = TaskId.safeParse(event.payload);
        if (proposal.success) handler.current({ kind: "proposal", id: proposal.data });
      }),
    ];
    return () => {
      for (const unlisten of stops) void unlisten.then((stop) => stop());
    };
  }, []);
}
