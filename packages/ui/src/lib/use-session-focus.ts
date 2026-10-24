import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { SessionId, TaskId } from "@trackwall/protocol";
import { useEffect, useRef } from "react";
import { z } from "zod";

/**
 * Tauri shell event: the user clicked a waiting session (ADR-26) or a task proposal (ADR-39) in the tray menu, in a
 * system notification or in the tray panel, or pressed the global shortcut for the next waiting session (ADR-50).
 * The name and shape (`Focus`) are also in `apps/desktop/src-tauri/src/attention.rs`.
 */
const FOCUS_EVENT = "focus-session";
const ShellFocus = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session"), id: SessionId }),
  z.object({ kind: z.literal("proposal"), id: TaskId }),
  z.object({ kind: z.literal("next-waiting") }),
]);
export type ShellFocus = z.infer<typeof ShellFocus>;

/** Calls `onFocus` with what the shell asks to show; does nothing outside the Tauri window. */
export function useSessionFocus(onFocus: (focus: ShellFocus) => void): void {
  const handler = useRef(onFocus);
  handler.current = onFocus;
  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = listen<unknown>(FOCUS_EVENT, (event) => {
      const focus = ShellFocus.safeParse(event.payload);
      if (focus.success) handler.current(focus.data);
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);
}
