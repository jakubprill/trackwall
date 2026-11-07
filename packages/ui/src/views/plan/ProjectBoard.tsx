import { type BoardItem, boardApi } from "@trackwall/protocol";
import { type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { post } from "@/lib/api";
import { COLUMN_LABELS } from "@/lib/board-tree";
import type { Connection } from "@/lib/connection";
import { type ItemTaskIndex, itemTasks } from "@/lib/plan-progress";
import { BOARD_COLUMNS, type BoardCard, type BoardViewColumn, canMoveCard, cardKeyMove, projectBoard } from "@/lib/project-board";
import { useAction } from "@/lib/use-action";
import { columnProps, useCardDrag } from "@/lib/use-card-drag";
import { cn } from "@/lib/utils";
import { RowTask } from "./RowTask.tsx";

/**
 * A project of Plan as a board (ADR-217): its items not split further as cards in columns, each with the item it was split
 * from, its repos and what its task is doing. A card follows its tasks into In progress and In review by itself (ADR-213);
 * the user drags it to another column (`useCardDrag`), or moves it with Alt+← and Alt+→ on the focused card. Selecting a
 * card opens the item in the right column.
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
  // A moved card takes the focus once it shows up in its new column, after the board is read again, so it can move on.
  // The board it was moved on is kept: once another board has rendered, the card had its chance (it may sit in a hidden
  // column, or the daemon may have put it elsewhere), and a later board does not take the focus to it.
  const [follow, setFollow] = useState<{ id: string; column: BoardViewColumn; on: readonly BoardItem[] }>();
  const [moved, setMoved] = useState("");
  const move = useAction(
    async (card: BoardCard, column: BoardViewColumn) => {
      await post(conn, boardApi.update, { item: card.item.id, column });
      return { id: card.item.id, column, text: `${card.item.title} moved to ${COLUMN_LABELS[column]}.` };
    },
    (done) => {
      setFollow({ id: done.id, column: done.column, on: itemsRef.current });
      setMoved(done.text);
      onChanged();
    },
  );
  const itemsRef = useRef(items);
  itemsRef.current = items;
  // Runs after the cards' own effects, so a card that showed up in its column has taken the focus by then.
  useEffect(() => {
    if (follow && follow.on !== items) setFollow(undefined);
  }, [follow, items]);
  // Recounted on a board change, not on every drag over a column or selection.
  const board = useMemo(() => projectBoard(items, project), [items, project]);
  const columns = BOARD_COLUMNS.filter((column) => !hideDone || column !== "done");
  const tryMove = (card: BoardCard | undefined, to: BoardViewColumn) => {
    if (card && !move.pending && canMoveCard(card, to)) move.run(card, to);
  };
  const { drag, press, clickEndsDrag } = useCardDrag((id, column) => tryMove(board.cards.get(id), column));
  const dragged = drag && board.cards.get(drag.card);
  return (
    <div className="flex flex-col gap-2">
      {move.error && <p className="text-destructive text-sm whitespace-pre-wrap">{move.error}</p>}
      <p aria-live="polite" className="sr-only">
        {moved}
      </p>
      <div className={cn("grid auto-cols-[minmax(11rem,1fr)] grid-flow-col gap-2 overflow-x-auto", drag && "select-none")}>
        {columns.map((column) => (
          <section
            key={column}
            aria-label={COLUMN_LABELS[column]}
            {...columnProps(column)}
            className={cn(
              "bg-secondary/40 flex min-h-40 flex-col gap-2 rounded-md border p-2",
              // Only where the drop would move the card.
              dragged && drag.over === column && !move.pending && canMoveCard(dragged, column) && "border-primary",
            )}
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
                focused={card.item.id === follow?.id && column === follow.column}
                onFocused={() => setFollow(undefined)}
                disabled={move.pending}
                dragged={card.item.id === drag?.card}
                onSelect={() => {
                  if (!clickEndsDrag()) onSelect(card.item.id);
                }}
                onMove={(to) => tryMove(card, to)}
                onPress={(e) => press(e, card.item.id)}
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
  onFocused,
  disabled,
  dragged,
  onSelect,
  onMove,
  onPress,
}: {
  card: BoardCard;
  column: BoardViewColumn;
  taskIndex: ItemTaskIndex;
  selected: boolean;
  /** Takes the focus when it shows up in the column it was just moved to. */
  focused: boolean;
  onFocused: () => void;
  disabled: boolean;
  /** Being dragged to another column. */
  dragged: boolean;
  onSelect: () => void;
  onMove: (to: BoardViewColumn) => void;
  /** A press that may become a drag. */
  onPress: (e: PointerEvent<HTMLButtonElement>) => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!focused) return;
    button.current?.focus();
    onFocused();
  }, [focused, onFocused]);
  const closedWith = `Closed with ${splitFrom?.title ?? "the item above it"}; it moves with that item in the outline.`;
  return (
    <button
      ref={button}
      type="button"
      onPointerDown={(e) => {
        // A card below a done or dropped item moves with that item, in the outline.
        if (!closedAbove && !disabled) onPress(e);
      }}
      onClick={() => {
        // WebKit does not focus a clicked button, and Alt+← and Alt+→ need the focus on the card.
        button.current?.focus();
        onSelect();
      }}
      onKeyDown={(e) => {
        const to = cardKeyMove(e.nativeEvent, column);
        if (to === undefined) return;
        // Alt+← is also the browser's Back: the board keeps it even where the card cannot move.
        e.preventDefault();
        if (to !== null) onMove(to);
      }}
      aria-current={selected ? "true" : undefined}
      aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
      title={closedAbove ? closedWith : undefined}
      className={cn(
        // No text selection on a card: in WKWebView one can turn into a native drag, which the window takes (ADR-217).
        "bg-card hover:bg-accent flex flex-col gap-1.5 rounded-md border px-2.5 py-2 text-left text-sm select-none",
        selected && "bg-accent text-accent-foreground border-primary",
        closedAbove && "opacity-60",
        dragged && "opacity-50",
      )}
    >
      {splitFrom && <span className="text-muted-foreground truncate text-xs">{splitFrom.title}</span>}
      <span className="break-words">{item.title}</span>
      {closedAbove && <span className="sr-only">{closedWith}</span>}
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
