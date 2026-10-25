import { agentsApi, type Session } from "@trackwall/protocol";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { closeCutsOffTurn, isLive } from "@/lib/session-state";
import { useAction } from "@/lib/use-action";
import { cn } from "@/lib/utils";

/**
 * Closing a session from a grid tile or a list row (ADR-48): one click stops its process group if it still runs and
 * removes the session from the list. A task's session closes alone; the task and its worktree stay on the list to be
 * resumed or ended in the task panel. While the agent is in the middle of a turn the close waits for a second click
 * (`closeCutsOffTurn`), so a stray click does not cut off its work. Without a session (a proposal, a task whose session
 * is closed) there is nothing to close and the caller shows no button.
 */
export function useSessionClose(conn: Connection, session: Session | undefined, onClosed: () => void) {
  const [confirming, setConfirming] = useState(false);
  const cutsOff = session !== undefined && closeCutsOffTurn(session);
  // A question left open after the turn ended would come back by itself at the agent's next turn.
  useEffect(() => {
    if (!cutsOff) setConfirming(false);
  }, [cutsOff]);
  const close = useAction(async () => {
    if (!session) return;
    if (isLive(session)) await post(conn, agentsApi.stop, { session: session.id });
    await post(conn, agentsApi.dismiss, { session: session.id });
  }, onClosed);
  return {
    pending: close.pending,
    error: close.error,
    confirming: confirming && cutsOff,
    request: () => (cutsOff ? setConfirming(true) : close.run()),
    confirm: close.run,
    cancel: () => setConfirming(false),
  };
}

export type SessionClose = ReturnType<typeof useSessionClose>;

/** The X button. A mouse press on it does not take the focus, so that it does not first select the tile or row it sits in. */
export function SessionCloseButton({ close, className }: { close: SessionClose; className?: string }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("size-6 shrink-0", className)}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={close.request}
      disabled={close.pending}
      aria-label="Close session"
      title="Close session"
    >
      <X />
    </Button>
  );
}

/** The question after the first click while the agent works, and an error from stopping or closing. */
export function SessionCloseConfirmation({ close }: { close: SessionClose }) {
  if (!close.confirming && !close.error) return null;
  return (
    <div role="alertdialog" aria-label="Close session" className="bg-card flex flex-wrap items-center gap-2 border-b px-2 py-1.5">
      {close.confirming && (
        <>
          <span className="text-warning text-xs">The agent is working. Stop it and close the session?</span>
          <Button variant="destructive" size="sm" className="h-6 px-2 text-xs" disabled={close.pending} onClick={close.confirm}>
            Close
          </Button>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={close.pending} onClick={close.cancel}>
            Cancel
          </Button>
        </>
      )}
      {close.error && <span className="text-destructive min-w-0 truncate text-xs">{close.error}</span>}
    </div>
  );
}
