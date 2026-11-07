/**
 * Dragging a card of the board with the pointer (ADR-217): a press on a card that goes `CARD_DRAG_DISTANCE` becomes a
 * drag, the column under the pointer is marked, and releasing it there drops the card into that column. Escape gives
 * the drag up. Pointer events, because the desktop shell takes every native drag over its window for dropping files
 * (ADR-51), so HTML5 drag and drop never reaches the page in WKWebView or WebView2 (architecture §5.4).
 */
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { BOARD_COLUMNS, type BoardViewColumn } from "./project-board.ts";

/** Names a column on its element, so a dragged card finds the column under the pointer. */
const COLUMN_ATTRIBUTE = "data-board-column";

/** How far, in CSS pixels, a pressed card goes before it is dragged rather than clicked. */
const CARD_DRAG_DISTANCE = 4;

/** Whether the pointer, pressed on a card at `from`, has gone far enough to drag it. */
export function isCardDrag(from: { x: number; y: number }, to: { x: number; y: number }): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) >= CARD_DRAG_DISTANCE;
}

/** The column a `data-board-column` value names; `undefined` for anything else, a missing value included. */
export function columnNamed(value: string | null | undefined): BoardViewColumn | undefined {
  return BOARD_COLUMNS.find((column) => column === value);
}

/** The props that make an element the drop place of `column`. */
export function columnProps(column: BoardViewColumn): { [COLUMN_ATTRIBUTE]: BoardViewColumn } {
  return { [COLUMN_ATTRIBUTE]: column };
}

export interface CardDrag {
  card: string;
  /** The column under the pointer; `undefined` between or outside the columns. */
  over: BoardViewColumn | undefined;
}

type Phase = "pressed" | "dragging" | "given up";

function columnAt(x: number, y: number): BoardViewColumn | undefined {
  const column = document.elementFromPoint(x, y)?.closest(`[${COLUMN_ATTRIBUTE}]`);
  return columnNamed(column?.getAttribute(COLUMN_ATTRIBUTE));
}

export function useCardDrag(onDrop: (card: string, column: BoardViewColumn) => void) {
  const [drag, setDrag] = useState<CardDrag>();
  const drop = useRef(onDrop);
  drop.current = onDrop;
  // The click that follows the release of a drag is not a click on the card.
  const clickEndsDrag = useRef(false);
  const release = useRef<() => void>(undefined);
  useEffect(() => () => release.current?.(), []);

  const press = (e: ReactPointerEvent<HTMLElement>, card: string) => {
    // Ctrl+click is the context menu on macOS, which keeps the release.
    if (e.button !== 0 || e.ctrlKey) return;
    release.current?.();
    const from = { x: e.clientX, y: e.clientY };
    const pointer = e.pointerId;
    const target = e.currentTarget;
    let phase: Phase = "pressed";
    let over: BoardViewColumn | undefined;

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointer) return;
      // A release the page never saw (the window lost the pointer) ends the press, so no drag starts without a button.
      if ((ev.buttons & 1) === 0) return end();
      if (phase === "pressed" && isCardDrag(from, { x: ev.clientX, y: ev.clientY })) {
        phase = "dragging";
        target.setPointerCapture(pointer);
        over = columnAt(ev.clientX, ev.clientY);
        setDrag({ card, over });
      } else if (phase === "dragging") overColumn(columnAt(ev.clientX, ev.clientY));
    };
    // The board renders again only when the pointer reaches another column.
    const overColumn = (column: BoardViewColumn | undefined) => {
      if (column === over) return;
      over = column;
      setDrag({ card, over });
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== pointer) return;
      const dropped = phase === "dragging" ? over : undefined;
      if (phase !== "pressed") {
        clickEndsDrag.current = true;
        // The click, if any, comes right after this release, in the same task.
        window.setTimeout(() => {
          clickEndsDrag.current = false;
        });
      }
      end();
      if (dropped) drop.current(card, dropped);
    };
    const cancel = (ev: PointerEvent) => {
      if (ev.pointerId === pointer) end();
    };
    const giveUp = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || phase !== "dragging") return;
      ev.preventDefault();
      ev.stopPropagation();
      phase = "given up";
      setDrag(undefined);
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", giveUp, true);
      release.current = undefined;
      setDrag(undefined);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", giveUp, true);
    release.current = end;
  };

  return {
    drag,
    press,
    /** Whether a click on a card is the release of a drag, so that it does not select the card as well. */
    clickEndsDrag: () => clickEndsDrag.current,
  };
}
