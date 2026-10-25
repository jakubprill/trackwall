import { X } from "lucide-react";
import type { MouseEvent } from "react";
import { Button } from "@/components/ui/button";
import type { SessionClose } from "@/lib/use-session-close";
import { cn } from "@/lib/utils";

/**
 * A mouse press on the close controls does not take the focus and does not reach the tile, so that closing a tile that
 * is not selected does not select it first (a tile selects itself on focus and on a mouse press).
 */
function keepSelection(event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
}

/** The X that closes a session (`useSessionClose`). */
export function SessionCloseButton({ close, className }: { close: SessionClose; className?: string }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("size-6 shrink-0", className)}
      onMouseDown={keepSelection}
      onClick={close.request}
      disabled={close.pending}
      aria-label="Close session"
      title="Close session"
    >
      <X />
    </Button>
  );
}

/** The question after the first click while the agent is in the middle of a turn, and an error from stopping or closing. */
export function SessionCloseConfirmation({ close, className }: { close: SessionClose; className?: string }) {
  if (!close.confirming && !close.error) return null;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the handler only keeps a press on the strip from selecting the tile; the buttons inside are the controls.
    <div
      {...(close.confirming ? { role: "alertdialog", "aria-label": "Close session" } : { role: "alert" })}
      onMouseDown={keepSelection}
      className={cn("bg-card flex flex-wrap items-center gap-2 border-b px-2 py-1.5", className)}
    >
      {close.confirming && (
        <>
          <span className="text-warning text-xs">The agent is in the middle of a turn. Stop it and close the session?</span>
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
