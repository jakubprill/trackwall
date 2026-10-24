import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { SessionId, TaskId } from "@trackwall/protocol";
import { useEffect, useRef } from "react";
import { z } from "zod";
import type { SessionSelection } from "./session-entries.ts";

/**
 * Zdarzenie powłoki Tauri: użytkownik kliknął w trayu sesję, która czeka (ADR-26), albo propozycję zadania (ADR-39).
 * Nazwa i kształt (`Focus`) są też w `apps/desktop/src-tauri/src/attention.rs`.
 */
const FOCUS_EVENT = "focus-session";
const Focus = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session"), id: SessionId }),
  z.object({ kind: z.literal("proposal"), id: TaskId }),
]);

/** Wywołuje `onFocus` z pozycją widoku „Sessions”, gdy powłoka prosi o pokazanie jej; poza oknem Tauri nic nie robi. */
export function useSessionFocus(onFocus: (selection: SessionSelection) => void): void {
  const handler = useRef(onFocus);
  handler.current = onFocus;
  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = listen<unknown>(FOCUS_EVENT, (event) => {
      const focus = Focus.safeParse(event.payload);
      if (focus.success) handler.current(focus.data);
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);
}
