import { agentsApi, type Session } from "@trackwall/protocol";
import { useEffect, useState } from "react";
import { errorCode, post } from "./api.ts";
import type { Connection } from "./connection.ts";
import { closeCutsOffTurn, isLive } from "./session-state.ts";
import { useAction } from "./use-action.ts";

/**
 * Closing a session from a grid tile, a list row or the session panel (ADR-48): one click stops its process group if it
 * still runs and removes the session from the list. A task's session closes alone; the task and its worktree stay on
 * the list to be resumed or ended in the task panel. While the agent is in the middle of a turn the close waits for a
 * second click (`closeCutsOffTurn`), so a stray click does not cut off its work. Without a session (a proposal, a task
 * whose session is closed) there is nothing to close and the caller shows no button.
 */
export function useSessionClose(conn: Connection, session: Session | undefined, onClosed: () => void) {
  const [confirming, setConfirming] = useState(false);
  // The session the last close was for: its error must not stay on a tile or row that shows another session by now.
  const [target, setTarget] = useState<string>();
  const cutsOff = session !== undefined && closeCutsOffTurn(session);
  // A question left open after the turn ended would come back by itself at the agent's next turn.
  useEffect(() => {
    if (!cutsOff) setConfirming(false);
  }, [cutsOff]);
  const close = useAction(async (closing: Session) => {
    setTarget(closing.id);
    if (isLive(closing)) await post(conn, agentsApi.stop, { session: closing.id });
    // The same session is also on a list row next to its tile, so a close from the other one may have removed it first.
    await post(conn, agentsApi.dismiss, { session: closing.id }).catch((err: unknown) => {
      if (errorCode(err) !== "not_found") throw err;
    });
  }, onClosed);
  const run = () => {
    if (session) close.run(session);
  };
  return {
    pending: close.pending,
    error: session !== undefined && target === session.id ? close.error : undefined,
    confirming: confirming && cutsOff,
    request: () => (cutsOff ? setConfirming(true) : run()),
    confirm: run,
    cancel: () => setConfirming(false),
  };
}

export type SessionClose = ReturnType<typeof useSessionClose>;
