import { type FolderTerminal, type TerminalPlace, terminalSocket, terminalsApi } from "@trackwall/protocol";
import { FolderOpen, RotateCcw, SquareTerminal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FolderFiles } from "@/components/FolderFiles";
import { type PtyKind, PtyTerminal } from "@/components/PtyTerminal";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { reopensOnOpen } from "@/lib/folder-terminals";
import { useAction } from "@/lib/use-action";
import { useFolderTerminal } from "@/lib/use-folder-terminal";

const SHELL: PtyKind = {
  copilotCli: false,
  noun: "shell",
  ended: "The shell has ended; the terminal shows what was left on its screen.",
};

/**
 * The Shell tab of a repo or a task (ADR-185): the user's own shell in the repo root or the task's worktree, in the
 * daemon, so it runs where the daemon runs (in a container, in the container). The tab shows the shell already open
 * there, or "Open a shell": a shell starts only when the user asks (ADR-211), since Ctrl+PageDown passes through the
 * tab on the way to the next one. It keeps running when the tab closes, until the user closes it.
 */
export function FolderShell({ conn, place, folder }: { conn: Connection; place: TerminalPlace; folder: string }) {
  const listed = useFolderTerminal(conn, place);
  // The start's own answer until the list has it, so the tab does not flash "Open a shell" in between.
  const [started, setStarted] = useState<FolderTerminal>();
  const open = useAction(
    () => post(conn, terminalsApi.start, place),
    (terminal) => {
      setStarted(terminal);
      listed.reload();
    },
  );
  const close = useAction(
    (id: string) => post(conn, terminalsApi.close, { terminal: id }),
    () => {
      setStarted(undefined);
      listed.reload();
    },
  );
  const terminal = listed.terminal ?? started;
  // Closed in every new tab, like the diff panel: the terminal is what the tab is for.
  const [filesOpen, setFilesOpen] = useState(false);
  // Once the list has the shell, it alone says what happens to it (an end, a close in another window).
  useEffect(() => {
    if (listed.terminal) setStarted(undefined);
  }, [listed.terminal]);
  const asked = useRef(false);
  const openRef = useRef(open.run);
  openRef.current = open.run;
  const hasLiveShell = listed.terminal !== undefined && listed.terminal.run.kind !== "exited";
  useEffect(() => {
    if (!reopensOnOpen({ loaded: listed.loaded, hasLiveShell, alreadyAsked: asked.current })) return;
    asked.current = true;
    openRef.current();
  }, [listed.loaded, hasLiveShell]);
  // The button takes the keyboard, so that Ctrl+PageDown and Enter open the shell without the mouse.
  const openButton = useRef<HTMLButtonElement>(null);
  const showsOpen = listed.loaded && terminal === undefined;
  useEffect(() => {
    if (showsOpen) openButton.current?.focus();
  }, [showsOpen]);

  const actionError = open.error ?? close.error ?? listed.error;
  // Nothing until the list came, so that a shell already open does not flash "Open a shell" first.
  if (!terminal && !listed.loaded) return null;
  if (!terminal)
    return (
      <div className="flex flex-col items-start gap-2 p-4">
        <p className="text-muted-foreground text-sm">
          A shell of your own in <span className="font-mono break-all">{folder}</span>.
        </p>
        {actionError && <p className="text-destructive text-sm">{actionError}</p>}
        <Button
          ref={openButton}
          variant="outline"
          size="sm"
          onClick={() => {
            // The shell this starts is the tab's own: the list bringing it is no reason to ask again.
            asked.current = true;
            open.run();
          }}
          disabled={open.pending}
        >
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
        <Button
          variant={filesOpen ? "secondary" : "outline"}
          size="sm"
          onClick={() => setFilesOpen((open) => !open)}
          aria-pressed={filesOpen}
          title="The files in this folder as they are now, to download"
        >
          <FolderOpen /> Files on disk
        </Button>
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
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <PtyTerminal
            key={terminal.id}
            conn={conn}
            socket={terminalSocket(terminal.id)}
            screenKey={terminal.id}
            live={live}
            selected
            kind={SHELL}
          />
        </div>
        {filesOpen && (
          <div className="flex w-72 max-w-1/2 shrink-0 flex-col">
            <FolderFiles conn={conn} place={place} />
          </div>
        )}
      </div>
    </div>
  );
}
