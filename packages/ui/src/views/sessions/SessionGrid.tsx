import type { RunningMiseTask, Session, Task, TaskMessage } from "@trackwall/protocol";
import { Maximize2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SessionScreen } from "@/components/SessionScreen";
import { StatusLabel } from "@/components/StatusLabel";
import { Button } from "@/components/ui/button";
import type { Connection } from "@/lib/connection";
import type { LiveFeed } from "@/lib/daemon-events";
import { IS_MAC } from "@/lib/platform";
import { entryId, entrySession, proposalsName, type SessionEntry, type SessionSelection } from "@/lib/session-entries";
import { type GridPage, gridShape } from "@/lib/session-grid";
import { sessionShortcutLabel } from "@/lib/session-shortcut";
import { PROPOSAL_STATUS, sessionPlace, sessionStateLabel } from "@/lib/session-state";
import { useSessionClose } from "@/lib/use-session-close";
import { useTaskEnding } from "@/lib/use-task-ending";
import { useTileOverlay } from "@/lib/use-tile-overlay";
import { cn } from "@/lib/utils";
import { ProposalTile } from "./ProposalTile.tsx";
import { EndTaskButton, SessionCloseButton, SessionCloseConfirmation, TaskEnding } from "./SessionClose.tsx";
import { useSessionEnvironmentTile } from "./SessionEnvironmentTile.tsx";
import { TaskLine } from "./TaskLine.tsx";
import { useTaskTileMenu } from "./TaskTileMenu.tsx";
import { useTaskTileNotices } from "./TaskTileNotices.tsx";

/**
 * A page of the Sessions list as a grid of terminals (ADR-48). The selected tile has the accent ring and the keyboard,
 * a session that is waiting for you has the warning frame (also when selected). Clicking a tile or into its terminal
 * selects it; a task without a session has no terminal, so its tile leads to the full panel and its X ends the task
 * (`TaskRemoval`), and task proposals (ADR-39) show their prompts with “Start task” and “Reject…” (ADR-55). A tile
 * with a session also closes it (`useSessionClose`) and shows what it got from mise (`useSessionEnvironmentTile`).
 * Tiles appear once the area is measured, so that no terminal reports a size to its session from a layout that is
 * about to change.
 */
export function SessionGrid({
  conn,
  page,
  selected,
  onSelect,
  onOpenAlone,
  onOpenChanges,
  tasks,
  onChanged,
  onNavigate,
  currentSelection,
  onSessionClosed,
  onTaskRemoved,
  sessions,
  messages,
  runningLive,
}: {
  conn: Connection;
  page: GridPage<SessionEntry>;
  selected: string;
  onSelect: (entry: SessionEntry) => void;
  onOpenAlone: (entry: SessionEntry) => void;
  /** "Changes" in a task tile's menu: the task alone, on its changes. */
  onOpenChanges: (task: string) => void;
  /** For a proposals tile: the tasks for the same-repo hint, the list reload and the selection after a decision. */
  tasks: readonly Task[];
  onChanged: () => void;
  onNavigate: (selection: SessionSelection) => void;
  currentSelection: () => SessionSelection;
  onSessionClosed: (entry: SessionEntry) => void;
  onTaskRemoved: (task: string) => void;
  /** For a task tile's notices (ADR-91): the sessions that sent its messages, the messages and the running mise tasks. */
  sessions: readonly Session[];
  messages: readonly TaskMessage[];
  runningLive: LiveFeed<RunningMiseTask[]> | undefined;
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
            onOpenChanges={onOpenChanges}
            tasks={tasks}
            onChanged={onChanged}
            onNavigate={onNavigate}
            currentSelection={currentSelection}
            onSessionClosed={() => onSessionClosed(entry)}
            onTaskRemoved={onTaskRemoved}
            sessions={sessions}
            messages={messages}
            runningLive={runningLive}
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
  onOpenChanges,
  tasks,
  onChanged,
  onNavigate,
  currentSelection,
  onSessionClosed,
  onTaskRemoved,
  sessions,
  messages,
  runningLive,
}: {
  conn: Connection;
  entry: SessionEntry;
  position: number;
  selected: boolean;
  onSelect: () => void;
  onOpenAlone: () => void;
  onOpenChanges: (task: string) => void;
  tasks: readonly Task[];
  onChanged: () => void;
  onNavigate: (selection: SessionSelection) => void;
  currentSelection: () => SessionSelection;
  onSessionClosed: () => void;
  onTaskRemoved: (task: string) => void;
  sessions: readonly Session[];
  messages: readonly TaskMessage[];
  runningLive: LiveFeed<RunningMiseTask[]> | undefined;
}) {
  const session = entrySession(entry);
  const close = useSessionClose(conn, session, onSessionClosed);
  const sessionlessTask = entry.kind === "task" && !session ? entry.task : undefined;
  const ending = useTaskEnding(sessionlessTask !== undefined);
  const task = entry.kind === "task" ? entry.task : undefined;
  const overlay = useTileOverlay();
  const notices = useTaskTileNotices({
    conn,
    task,
    tasks,
    messages: messages.filter((m) => m.task === task?.id),
    sessions,
    runningLive,
    selected,
    paused: ending.open,
    overlay,
    onOpenTask: (id) => onNavigate({ kind: "task", id }),
  });
  const menu = useTaskTileMenu({
    conn,
    task: ending.open ? undefined : task,
    session,
    verification: notices.details.verification,
    overlay,
    onOpenChanges: () => task && onOpenChanges(task.id),
    onChanged,
  });
  const environment = useSessionEnvironmentTile(session?.environment);
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
      {/* A container, so that a narrow tile shortens what its header says instead of cutting its buttons off. */}
      <header className="bg-card @container flex min-w-0 items-center gap-2 border-b px-2 py-1">
        <span
          className={cn(
            "text-2xs shrink-0 rounded-sm px-1 font-mono",
            selected ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground",
          )}
        >
          {sessionShortcutLabel({ kind: "position", position }, IS_MAC) ?? position}
        </span>
        <TileTitle entry={entry} />
        {notices.chips}
        {environment.badge}
        {menu.button}
        <Button variant="ghost" size="icon" className="size-6 shrink-0" onClick={onOpenAlone} aria-label="Open alone">
          <Maximize2 />
        </Button>
        {session && <SessionCloseButton close={close} />}
        {/* Ending the task takes the tile's body, so whatever lay over it closes. */}
        {sessionlessTask && (
          <EndTaskButton
            onClick={() => {
              overlay.close();
              ending.show();
            }}
          />
        )}
      </header>
      {/* The notices lie over the body like the close question, so that they do not resize the PTY. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* The task's notices come after the environment card, so that opening them lies over it. */}
        {environment.card}
        {notices.overlay}
        {menu.overlay}
        {session && (
          // The question lies over the terminal instead of pushing it down, so that it does not resize the PTY mid-turn.
          <div className="relative flex min-h-0 flex-1 flex-col">
            <SessionCloseConfirmation close={close} className="absolute inset-x-0 top-0 z-30" />
            <SessionScreen conn={conn} session={session} selected={selected} />
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
            This task has no session. Resume it from its menu, open it alone to see its changes, or end it with the X.
          </div>
        )}
      </div>
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
      <span className="min-w-0 truncate text-xs font-medium">{task?.repo ?? (session && sessionPlace(session))}</span>
      {/* In a narrow tile the state is its dot, with the text as the tooltip. */}
      <span className="text-muted-foreground shrink-0 text-xs" title={session ? sessionStateLabel(session).label : undefined}>
        {session ? <StatusLabel {...sessionStateLabel(session)} labelClassName="@max-lg:sr-only" /> : "no session"}
      </span>
      <span className="min-w-0 flex-1 truncate" title={task?.prompt ?? session?.windowTitle ?? undefined}>
        {task ? <TaskLine task={task} /> : <span className="text-muted-foreground text-xs">{session?.windowTitle}</span>}
      </span>
    </>
  );
}
