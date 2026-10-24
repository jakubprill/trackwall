import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { RepoId, SessionId, TaskId } from "@trackwall/protocol";
import { useEffect, useRef } from "react";
import { z } from "zod";

/**
 * A jump the Tauri shell asks for: a waiting session (ADR-26) or a task proposal (ADR-39) clicked in the tray, or a
 * `trackwall://` link to a repo, session or task (ADR-52). The shell keeps the jump and sends `JUMP_EVENT`; the UI
 * takes it with `TAKE_JUMP_COMMAND` on that event and once at start, because a link that started the app arrives
 * before the page listens. The names and the shape (`Jump`) are also in `apps/desktop/src-tauri/src/jump.rs`. The
 * shell checks only the shape of a link, so the ids are checked here against the protocol schemas.
 */
const JUMP_EVENT = "jump-requested";
const TAKE_JUMP_COMMAND = "take_jump";

const Jump = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("repo"), id: RepoId }),
  z.object({ kind: z.literal("session"), id: SessionId }),
  z.object({ kind: z.literal("task"), id: TaskId }),
  z.object({ kind: z.literal("proposal"), id: TaskId }),
]);
type Jump = z.infer<typeof Jump>;

/** Calls `onJump` when the shell asks to show something; does nothing outside the Tauri window. */
export function useJumpRequest(onJump: (jump: Jump) => void): void {
  const handler = useRef(onJump);
  handler.current = onJump;
  useEffect(() => {
    if (!isTauri()) return;
    const take = () =>
      invoke<unknown>(TAKE_JUMP_COMMAND).then(
        (taken) => {
          const jump = Jump.safeParse(taken);
          if (jump.success) handler.current(jump.data);
        },
        (err: unknown) => console.error("[jump] could not take the jump from the shell", err),
      );
    // This window's own listener: a global `listen` also gets events the shell sends to another window (ADR-49).
    const unlisten = getCurrentWebviewWindow().listen(JUMP_EVENT, () => void take());
    // After the listener is in place, so a jump sent in between is not lost; one sent before is taken here.
    void unlisten.then(take, take);
    return () => {
      void unlisten.then((stop) => stop()).catch(() => undefined);
    };
  }, []);
}
