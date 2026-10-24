import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { SessionId, TaskId } from "@trackwall/protocol";
import { useEffect, useRef } from "react";
import { z } from "zod";
import type { SessionSelection } from "./session-entries.ts";

/**
 * Tauri shell event: the user clicked a waiting session (ADR-26) or a task proposal (ADR-39) in the tray.
 * The name and shape (`Focus`) are also in `apps/desktop/src-tauri/src/attention.rs`.
 */
const FOCUS_EVENT = "focus-session";
const Focus = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session"), id: SessionId }),
  z.object({ kind: z.literal("proposal"), id: TaskId }),
]);

/** Calls `onFocus` with a Sessions view entry when the shell asks to show it; does nothing outside the Tauri window. */
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
