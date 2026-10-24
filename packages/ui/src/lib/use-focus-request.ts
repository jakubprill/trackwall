import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { RepoId, SessionId, TaskId } from "@trackwall/protocol";
import { useEffect, useRef } from "react";
import { z } from "zod";

/**
 * A jump the Tauri shell asks for: a waiting session (ADR-26) or a task proposal (ADR-39) clicked in the tray, or a
 * `trackwall://` link to a repo, session or task (ADR-52). The shell keeps the jump and sends `FOCUS_EVENT`; the UI
 * takes it with `TAKE_FOCUS_COMMAND` on that event and once at start, because a link that started the app arrives
 * before the page listens. The names and the shape (`Focus`) are also in `apps/desktop/src-tauri/src/focus.rs`.
 */
const FOCUS_EVENT = "focus-requested";
const TAKE_FOCUS_COMMAND = "take_focus";

const Focus = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("repo"), id: RepoId }),
  z.object({ kind: z.literal("session"), id: SessionId }),
  z.object({ kind: z.literal("task"), id: TaskId }),
  z.object({ kind: z.literal("proposal"), id: TaskId }),
]);
type Focus = z.infer<typeof Focus>;

/** Calls `onFocus` when the shell asks to show something; does nothing outside the Tauri window. */
export function useFocusRequest(onFocus: (focus: Focus) => void): void {
  const handler = useRef(onFocus);
  handler.current = onFocus;
  useEffect(() => {
    if (!isTauri()) return;
    const take = async () => {
      const focus = Focus.safeParse(await invoke<unknown>(TAKE_FOCUS_COMMAND));
      if (focus.success) handler.current(focus.data);
    };
    const unlisten = listen(FOCUS_EVENT, () => void take());
    // After the listener is in place, so a jump sent in between is not lost; one sent before is taken here.
    void unlisten.then(take);
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);
}
