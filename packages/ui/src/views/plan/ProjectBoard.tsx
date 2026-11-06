import { type BoardItem, boardApi } from "@trackwall/protocol";
import { type DragEvent, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { post } from "@/lib/api";
import { COLUMN_LABELS } from "@/lib/board-tree";
import type { Connection } from "@/lib/connection";
import { type ItemTaskIndex, itemTasks } from "@/lib/plan-progress";
import { BOARD_COLUMNS, type BoardCard, type BoardViewColumn, cardKeyMove, projectBoard } from "@/lib/project-board";
import { useAction } from "@/lib/use-action";
import { cn } from "@/lib/utils";
import { RowTask } from "./RowTask.tsx";

const CARD_TYPE = "application/x-trackwall-board-item";

/**
 * A project of Plan as a board (ADR-217): its items not split further as cards in columns, each with the item it was split
 * from, its repos and what its task is doing. A card follows its tasks into In progress and In review by itself (ADR-213);
 * the user drags it to another column, or moves it with Alt+← and Alt+→ on the focused card. Selecting a card opens the
 * item in the right column.
 */
export function ProjectBoard({
  conn,
  items,
  project,
  taskIndex,
  hideDone,
  selected,
  onSelect,
  onChanged,
}: {
  conn: Connection;
  items: readonly BoardItem[];
  project: string;
  taskIndex: ItemTaskIndex;
  hideDone: boolean;
  selected: string | undefined;
  onSelect: (id: string) => void;
  onChanged: () => void;
}) {
  const [over, setOver] = useState<BoardViewColumn>();
  // The card moved from the keyboard keeps the focus in its new column, so it can move on.
  const [follow, setFollow] = useState<string>();
  const move = useAction(
    async (id: string, column: BoardViewColumn) => {
      await post(conn, boardApi.update, { item: id, column });
      return id;
    },
    (id) => {
      setFollow(id);
      onChanged();
    },
  );
  const board = projectBoard(items, project);
  const columns = BOARD_COLUMNS.filter((column) => !hideDone || column !== "done");
  const drop = (column: BoardViewColumn) => (e: DragEvent) => {
    e.preventDefault();
    setOver(undefined);
    const id = e.dataTransfer.getData(CARD_TYPE);
    const card = Object.values(board.columns)
      .flat()
      .find((c) => c.item.id === id);
    if (card && !card.closedAbove && card.item.column !== column) move.run(id, column);
  };
  return (
    <div className="flex flex-col gap-2">
      {move.error && <p className="text-destructive text-sm whitespace-pre-wrap">{move.error}</p>}
      <div className="grid auto-cols-[minmax(11rem,1fr)] grid-flow-col gap-2 overflow-x-auto">
        {columns.map((column) => (
          <section
            key={column}
            aria-label={COLUMN_LABELS[column]}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(CARD_TYPE)) return;
              e.preventDefault();
              setOver(column);
            }}
            onDragLeave={() => setOver(undefined)}
            onDrop={drop(column)}
            className={cn("bg-secondary/40 flex min-h-40 flex-col gap-2 rounded-md border p-2", over === column && "border-primary")}
          >
            <h3 className="hud-label flex items-center gap-2 px-1">
              {COLUMN_LABELS[column]} <span className="text-muted-foreground font-mono">{board.columns[column].length}</span>
            </h3>
            {board.columns[column].map((card) => (
              <Card
                key={card.item.id}
                card={card}
                column={column}
                taskIndex={taskIndex}
                selected={card.item.id === selected}
                focused={card.item.id === follow}
                disabled={move.pending}
                onSelect={() => onSelect(card.item.id)}
                onMove={(to) => move.run(card.item.id, to)}
              />
            ))}
          </section>
        ))}
      </div>
      {board.dropped > 0 && <p className="text-muted-foreground text-xs">{board.dropped} dropped, not on the board.</p>}
      <p className="text-muted-foreground text-xs">
        A card moves to In progress when its task starts and to In review when the task hands its work over. Drag a card to another column,
        or press Alt+← and Alt+→ on it.
      </p>
    </div>
  );
}

function Card({
  card: { item, splitFrom, closedAbove },
  column,
  taskIndex,
  selected,
  focused,
  disabled,
  onSelect,
  onMove,
}: {
  card: BoardCard;
  column: BoardViewColumn;
  taskIndex: ItemTaskIndex;
  selected: boolean;
  /** Takes the focus when it shows up, in the column it was just moved to. */
  focused: boolean;
  disabled: boolean;
  onSelect: () => void;
  onMove: (to: BoardViewColumn) => void;
}) {
  // A card below a done or dropped item moves with that item, in the outline.
  const movable = !closedAbove && !disabled;
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focused) button.current?.focus();
  }, [focused]);
  return (
    <button
      ref={button}
      type="button"
      draggable={movable}
      onDragStart={(e) => {
        e.dataTransfer.setData(CARD_TYPE, item.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={onSelect}
      onKeyDown={(e) => {
        const to = movable ? cardKeyMove(e.nativeEvent, column) : undefined;
        if (!to) return;
        e.preventDefault();
        onMove(to);
      }}
      aria-current={selected ? "true" : undefined}
      title={closedAbove ? `Closed with ${splitFrom?.title ?? "the item above it"}` : undefined}
      className={cn(
        "bg-card hover:bg-accent flex flex-col gap-1.5 rounded-md border px-2.5 py-2 text-left text-sm",
        selected && "bg-accent text-accent-foreground border-primary",
        closedAbove && "opacity-60",
      )}
    >
      {splitFrom && <span className="text-muted-foreground truncate text-xs">{splitFrom.title}</span>}
      <span className="break-words">{item.title}</span>
      {item.repos.length > 0 && (
        <span className="flex flex-wrap gap-1">
          {item.repos.map((repo) => (
            <Badge key={repo} variant="outline" className="font-mono">
              {repo}
            </Badge>
          ))}
        </span>
      )}
      <RowTask tasks={itemTasks(item.id, taskIndex)} />
    </button>
  );
}
