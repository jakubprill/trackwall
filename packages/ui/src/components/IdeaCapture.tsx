import { boardApi } from "@trackwall/protocol";
import { Lightbulb } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { post } from "@/lib/api";
import { ideaFields } from "@/lib/board-tree";
import type { Connection } from "@/lib/connection";
import { isIdeaShortcut } from "@/lib/idea-shortcut";
import { IS_MAC } from "@/lib/platform";
import { useAction } from "@/lib/use-action";
import { useWindowShortcuts } from "@/lib/use-window-shortcuts";

/** How long "Saved to the inbox" stays after Enter. */
const SAVED_MS = 1800;

/**
 * The line for an idea (ADR-133), opened by Alt+N over every view: Enter saves it into the Plan view's inbox and closes,
 * Esc closes without saving. The keyboard goes back where it was, so writing an idea down does not take you out of a
 * session terminal.
 */
export function IdeaCapture({ conn }: { conn: Connection | undefined }) {
  const [open, setOpen] = useState(false);
  // Without a daemon there is nowhere to save it, so the key stays an ordinary key press.
  useWindowShortcuts(
    (event) => (conn && isIdeaShortcut(event, IS_MAC) ? true : undefined),
    () => {
      setOpen(true);
      return true;
    },
  );
  return conn ? <IdeaLine conn={conn} open={open} onClose={() => setOpen(false)} /> : null;
}

/** The line itself, and "Saved" after it closed. */
function IdeaLine({ conn, open, onClose }: { conn: Connection; open: boolean; onClose: () => void }) {
  const [text, setText] = useState("");
  const [saved, setSaved] = useState(false);
  const back = useRef<HTMLElement | null>(null);
  const close = () => {
    setText("");
    onClose();
    back.current?.focus();
  };
  const save = useAction(
    (fields: { title: string; body: string }) => post(conn, boardApi.create, { kind: "item", ...fields }),
    () => {
      setSaved(true);
      close();
    },
  );
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), SAVED_MS);
    return () => clearTimeout(timer);
  }, [saved]);
  if (!open)
    return saved ? (
      <p
        role="status"
        className="bg-card text-muted-foreground fixed top-4 left-1/2 z-50 -translate-x-1/2 rounded-md border px-4 py-2 text-sm shadow-lg"
      >
        Saved to the inbox in Plan
      </p>
    ) : null;
  const fields = ideaFields(text);
  return (
    <div className="bg-card fixed top-4 left-1/2 z-50 flex w-full max-w-xl -translate-x-1/2 flex-col gap-1 rounded-md border p-3 shadow-lg">
      <div className="flex items-center gap-2">
        <Lightbulb className="text-primary size-4 shrink-0" />
        <Input
          autoFocus
          aria-label="An idea for later"
          placeholder="An idea for later"
          value={text}
          disabled={save.pending}
          // Where the keyboard was before the line took it: a session terminal, a field of a view.
          onFocus={(e) => {
            back.current = e.relatedTarget instanceof HTMLElement ? e.relatedTarget : null;
          }}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
            if (e.key === "Enter" && fields) save.run(fields);
          }}
        />
      </div>
      <p className="text-muted-foreground text-xs">Enter saves it to the inbox in Plan, Esc closes.</p>
      {save.error && <p className="text-destructive text-xs">{save.error}</p>}
    </div>
  );
}
