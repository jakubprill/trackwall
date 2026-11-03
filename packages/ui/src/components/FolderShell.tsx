import { type TerminalPlace, terminalSocket, terminalsApi } from "@trackwall/protocol";
import { RotateCcw, SquareTerminal, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { PtyTerminal, type PtyTerminalWords } from "@/components/PtyTerminal";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { useAction } from "@/lib/use-action";
import { useFolderTerminal } from "@/lib/use-folder-terminal";

const SHELL_WORDS: PtyTerminalWords = {
  noun: "shell",
  ended: "The shell has ended; the terminal shows what was left on its screen.",
};

/**
 * The Shell tab of a repo or a task (ADR-185): the user's own shell in the repo root or the task's worktree, in the
 * daemon, so it runs where the daemon runs (in a container, in the container). Opening the tab opens the place's
 * shell, or the one already open there; it keeps running when the tab closes, until the user closes it.
 */
export function FolderShell({ conn, place, folder }: { conn: Connection; place: TerminalPlace; folder: string }) {
  const { loaded, terminal, error, reload } = useFolderTerminal(conn, place);
  const open = useAction(() => post(conn, terminalsApi.start, place), reload);
  const close = useAction((id: string) => post(conn, terminalsApi.close, { terminal: id }), reload);
  // Once per tab: a start that failed waits for the button, so an error does not start again on every render.
  const asked = useRef(false);
  useEffect(() => {
    if (!loaded || terminal || asked.current) return;
    asked.current = true;
    open.run();
  }, [loaded, terminal, open.run]);

  const actionError = open.error ?? close.error ?? error;
  if (!terminal)
    return (
      <div className="flex flex-col items-start gap-2 p-4">
        <p className="text-muted-foreground text-sm">
          A shell of your own in <span className="font-mono break-all">{folder}</span>.
        </p>
        {actionError && <p className="text-destructive text-sm">{actionError}</p>}
        <Button variant="outline" size="sm" onClick={() => open.run()} disabled={open.pending}>
          <SquareTerminal /> {open.pending ? "Opening…" : "Open a shell"}
        </Button>
      </div>
    );
  const live = terminal.run.kind !== "exited";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-1">
        <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs" title={folder}>
          {folder}
        </span>
        {actionError && <span className="text-destructive max-w-xs truncate text-xs">{actionError}</span>}
        {!live && (
          <Button variant="outline" size="sm" onClick={() => open.run()} disabled={open.pending}>
            <RotateCcw /> Start again
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => close.run(terminal.id)}
          disabled={close.pending}
          title="End the shell and everything it runs"
        >
          <X /> Close
        </Button>
      </div>
      <PtyTerminal
        key={terminal.id}
        conn={conn}
        socket={terminalSocket(terminal.id)}
        screenKey={terminal.id}
        live={live}
        selected
        words={SHELL_WORDS}
      />
    </div>
  );
}
