import { GitBranch, Maximize2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { StatusLabel } from "@/components/StatusLabel";
import { Button } from "@/components/ui/button";
import type { Connection } from "@/lib/connection";
import { IS_MAC } from "@/lib/platform";
import { entryId, type SessionEntry } from "@/lib/session-entries";
import { gridShape } from "@/lib/session-grid";
import { positionShortcutLabel } from "@/lib/session-shortcut";
import { isLive, sessionStateLabel } from "@/lib/session-state";
import { cn } from "@/lib/utils";
import { SessionTerminal } from "./SessionTerminal.tsx";

/** An entry on the grid's page with its position in the whole list, which its shortcut and number refer to. */
export interface GridTile {
  entry: SessionEntry;
  position: number;
}

/**
 * A page of the Sessions list as a grid of terminals (ADR-48). The focused tile has the accent frame and the keyboard
 * focus, a session that is waiting for you has the warning frame. Clicking a tile or into its terminal focuses it;
 * a task without a session has no terminal, so its tile only leads to the full panel.
 */
export function SessionGrid({
  conn,
  tiles,
  focused,
  onFocus,
  onOpenAlone,
}: {
  conn: Connection;
  tiles: readonly GridTile[];
  focused: string | undefined;
  onFocus: (entry: SessionEntry) => void;
  onOpenAlone: (entry: SessionEntry) => void;
}) {
  const area = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = area.current;
    if (!element) return;
    const observer = new ResizeObserver(([item]) => {
      if (item) setSize({ width: item.contentRect.width, height: item.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const { cols, rows } = gridShape(tiles.length, size.width, size.height);

  return (
    <div
      ref={area}
      className="grid min-h-0 flex-1 gap-2 p-2"
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}
    >
      {tiles.map(({ entry, position }) => (
        <SessionTile
          key={entryId(entry)}
          conn={conn}
          entry={entry}
          position={position}
          focused={entryId(entry) === focused}
          onFocus={() => onFocus(entry)}
          onOpenAlone={() => onOpenAlone(entry)}
        />
      ))}
    </div>
  );
}

function SessionTile({
  conn,
  entry,
  position,
  focused,
  onFocus,
  onOpenAlone,
}: {
  conn: Connection;
  entry: SessionEntry;
  position: number;
  focused: boolean;
  onFocus: () => void;
  onOpenAlone: () => void;
}) {
  const { session } = entry;
  const task = entry.kind === "task" ? entry.task : undefined;
  const shortcut = positionShortcutLabel(position, IS_MAC);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: focus inside the tile (its terminal or buttons) selects it; the tile itself is not a control.
    <div
      onFocus={() => {
        if (!focused) onFocus();
      }}
      onMouseDown={() => {
        if (!focused) onFocus();
      }}
      className={cn(
        "bg-background flex min-h-0 min-w-0 flex-col overflow-hidden rounded-md border",
        focused
          ? "border-primary ring-primary shadow-glow-primary ring-1"
          : session?.needsAttention && "border-warning shadow-glow-warning",
      )}
    >
      <header className="bg-card flex min-w-0 items-center gap-2 border-b px-2 py-1">
        <span
          className={cn(
            "text-2xs shrink-0 rounded-sm px-1 font-mono",
            focused ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground",
          )}
        >
          {shortcut ?? position}
        </span>
        <span className="shrink-0 truncate text-xs font-medium">{task?.repo ?? session?.repo}</span>
        <span className="text-muted-foreground shrink-0 text-xs">
          {session ? <StatusLabel {...sessionStateLabel(session)} /> : "no session"}
        </span>
        <span
          className="text-muted-foreground flex min-w-0 flex-1 items-center gap-1 text-xs"
          title={task?.prompt ?? session?.windowTitle ?? undefined}
        >
          {task && <GitBranch className="size-3 shrink-0" aria-label="task in a worktree" />}
          <span className="truncate">{task?.prompt ?? session?.windowTitle}</span>
        </span>
        <Button variant="ghost" size="icon" className="size-6" onClick={onOpenAlone} aria-label="Open this session alone">
          <Maximize2 />
        </Button>
      </header>
      {session ? (
        <SessionTerminal conn={conn} session={session.id} live={isLive(session)} focused={focused} />
      ) : (
        <div className="text-muted-foreground flex flex-1 items-center justify-center p-4 text-center text-xs">
          This task has no session. Open it alone to resume it or to see its changes.
        </div>
      )}
    </div>
  );
}
