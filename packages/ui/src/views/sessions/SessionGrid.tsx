import type { Task } from "@trackwall/protocol";
import { Maximize2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SessionTerminal } from "@/components/SessionTerminal";
import { StatusLabel } from "@/components/StatusLabel";
import { Button } from "@/components/ui/button";
import type { Connection } from "@/lib/connection";
import { IS_MAC } from "@/lib/platform";
import { entryId, entrySession, proposalsName, type SessionEntry, type SessionSelection } from "@/lib/session-entries";
import { type GridPage, gridShape } from "@/lib/session-grid";
import { sessionShortcutLabel } from "@/lib/session-shortcut";
import { isLive, PROPOSAL_STATUS, sessionStateLabel } from "@/lib/session-state";
import { useSessionClose } from "@/lib/use-session-close";
import { useTaskEnding } from "@/lib/use-task-ending";
import { cn } from "@/lib/utils";
import { ProposalTile } from "./ProposalTile.tsx";
import { EndTaskButton, SessionCloseButton, SessionCloseConfirmation, TaskEnding } from "./SessionClose.tsx";
import { TaskLine } from "./TaskLine.tsx";

/**
 * A page of the Sessions list as a grid of terminals (ADR-48). The selected tile has the accent ring and the keyboard,
 * a session that is waiting for you has the warning frame (also when selected). Clicking a tile or into its terminal
 * selects it; a task without a session has no terminal, so its tile leads to the full panel and its X ends the task
 * (`TaskRemoval`), and task proposals (ADR-39) show their prompts with “Start task” and “Reject…” (ADR-55). A tile
 * with a session also closes it (`useSessionClose`). Tiles appear once
 * the area is measured, so that no terminal reports a size to its session from a layout that is about to change.
 */
export function SessionGrid({
  conn,
  page,
  selected,
  onSelect,
  onOpenAlone,
  tasks,
  onChanged,
  onNavigate,
  currentSelection,
  onSessionClosed,
  onTaskRemoved,
}: {
  conn: Connection;
  page: GridPage<SessionEntry>;
  selected: string;
  onSelect: (entry: SessionEntry) => void;
  onOpenAlone: (entry: SessionEntry) => void;
  /** For a proposals tile: the tasks for the same-repo hint, the list reload and the selection after a decision. */
  tasks: readonly Task[];
  onChanged: () => void;
  onNavigate: (selection: SessionSelection) => void;
  currentSelection: () => SessionSelection;
  onSessionClosed: (entry: SessionEntry) => void;
  onTaskRemoved: (task: string) => void;
}) {
  const area = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number }>();
  useEffect(() => {
    const element = area.current;
    if (!element) return;
    const observer = new ResizeObserver(([item]) => {
      if (item) setSize({ width: item.contentRect.width, height: item.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const { cols, rows } = gridShape(page.slots, size?.width ?? 0, size?.height ?? 0);

  return (
    <div
      ref={area}
      className="grid min-h-0 flex-1 gap-2 p-2"
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}
    >
      {size &&
        page.tiles.map(({ entry, position }) => (
          <SessionTile
            key={entryId(entry)}
            conn={conn}
            entry={entry}
            position={position}
            selected={entryId(entry) === selected}
            onSelect={() => onSelect(entry)}
            onOpenAlone={() => onOpenAlone(entry)}
            tasks={tasks}
            onChanged={onChanged}
            onNavigate={onNavigate}
            currentSelection={currentSelection}
            onSessionClosed={() => onSessionClosed(entry)}
            onTaskRemoved={onTaskRemoved}
          />
        ))}
    </div>
  );
}

function SessionTile({
  conn,
  entry,
  position,
  selected,
  onSelect,
  onOpenAlone,
  tasks,
  onChanged,
  onNavigate,
  currentSelection,
  onSessionClosed,
  onTaskRemoved,
}: {
  conn: Connection;
  entry: SessionEntry;
  position: number;
  selected: boolean;
  onSelect: () => void;
  onOpenAlone: () => void;
  tasks: readonly Task[];
  onChanged: () => void;
  onNavigate: (selection: SessionSelection) => void;
  currentSelection: () => SessionSelection;
  onSessionClosed: () => void;
  onTaskRemoved: (task: string) => void;
}) {
  const session = entrySession(entry);
  const close = useSessionClose(conn, session, onSessionClosed);
  const sessionlessTask = entry.kind === "task" && !session ? entry.task : undefined;
  const ending = useTaskEnding(sessionlessTask !== undefined);
  const tile = useRef<HTMLDivElement>(null);
  // A selected tile without a terminal takes the keyboard itself, so that keys stop going to the terminal selected before.
  useEffect(() => {
    if (selected && !session) tile.current?.focus();
  }, [selected, session]);
  const select = () => {
    if (!selected) onSelect();
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: focus inside the tile (its terminal or buttons) selects it; the tile itself is not a control.
    <div
      ref={tile}
      tabIndex={-1}
      onFocus={select}
      onMouseDown={select}
      className={cn(
        "bg-background flex min-h-0 min-w-0 flex-col overflow-hidden rounded-md border outline-none",
        session?.needsAttention && "border-warning shadow-glow-warning",
        selected && "ring-primary ring-2",
      )}
    >
      <header className="bg-card flex min-w-0 items-center gap-2 border-b px-2 py-1">
        <span
          className={cn(
            "text-2xs shrink-0 rounded-sm px-1 font-mono",
            selected ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground",
          )}
        >
          {sessionShortcutLabel({ kind: "position", position }, IS_MAC) ?? position}
        </span>
        <TileTitle entry={entry} />
        <Button variant="ghost" size="icon" className="size-6 shrink-0" onClick={onOpenAlone} aria-label="Open alone">
          <Maximize2 />
        </Button>
        {session && <SessionCloseButton close={close} />}
        {sessionlessTask && <EndTaskButton onClick={ending.show} />}
      </header>
      {session && (
        // The question lies over the terminal instead of pushing it down, so that it does not resize the PTY mid-turn.
        <div className="relative flex min-h-0 flex-1 flex-col">
          <SessionCloseConfirmation close={close} className="absolute inset-x-0 top-0 z-10" />
          <SessionTerminal conn={conn} session={session.id} live={isLive(session)} selected={selected} />
        </div>
      )}
      {entry.kind === "proposals" && (
        <ProposalTile
          conn={conn}
          group={entry}
          tasks={tasks}
          onChanged={onChanged}
          onSelect={onNavigate}
          currentSelection={currentSelection}
        />
      )}
      {sessionlessTask && ending.open && (
        // A small tile scrolls the question, so that its buttons stay reachable.
        <TaskEnding
          className="min-h-0 flex-1 overflow-y-auto"
          conn={conn}
          task={sessionlessTask}
          onRemoved={() => onTaskRemoved(sessionlessTask.id)}
          onCancel={ending.hide}
        />
      )}
      {sessionlessTask && !ending.open && (
        <div className="text-muted-foreground flex flex-1 items-center justify-center p-4 text-center text-xs">
          This task has no session. Open it alone to resume it or to see its changes, or end it with the X.
        </div>
      )}
    </div>
  );
}

/** The tile header after its number: repo, state and what the entry is about (task, proposal or window title). */
function TileTitle({ entry }: { entry: SessionEntry }) {
  if (entry.kind === "proposals")
    return (
      <>
        <span className="min-w-0 truncate text-xs font-medium">{proposalsName(entry.proposals)}</span>
        <span className="shrink-0 text-xs">
          <StatusLabel {...PROPOSAL_STATUS} />
        </span>
        <span className="min-w-0 flex-1" />
      </>
    );
  const session = entrySession(entry);
  const task = entry.kind === "task" ? entry.task : undefined;
  return (
    <>
      <span className="min-w-0 truncate text-xs font-medium">{task?.repo ?? session?.repo}</span>
      <span className="text-muted-foreground shrink-0 text-xs">
        {session ? <StatusLabel {...sessionStateLabel(session)} /> : "no session"}
      </span>
      <span className="min-w-0 flex-1 truncate" title={task?.prompt ?? session?.windowTitle ?? undefined}>
        {task ? <TaskLine task={task} /> : <span className="text-muted-foreground text-xs">{session?.windowTitle}</span>}
      </span>
    </>
  );
}
