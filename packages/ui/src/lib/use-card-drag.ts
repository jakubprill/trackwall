import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { BOARD_COLUMN_ATTRIBUTE, type BoardViewColumn, columnNamed, isCardDrag } from "./project-board.ts";

/**
 * Dragging a card of the board with the pointer (ADR-217): a press on a card that goes `CARD_DRAG_DISTANCE` becomes a
 * drag, the column under the pointer is marked, and releasing it there drops the card into that column. Escape gives
 * the drag up. Pointer events, because the desktop shell takes every native drag over its window for dropping files
 * (ADR-51), so HTML5 drag and drop never reaches the page in WKWebView or WebView2.
 */
export interface CardDrag {
  card: string;
  /** The column under the pointer; `undefined` between or outside the columns. */
  over: BoardViewColumn | undefined;
}

type Phase = "pressed" | "dragging" | "given up";

export function useCardDrag(onDrop: (card: string, column: BoardViewColumn) => void) {
  const [drag, setDrag] = useState<CardDrag>();
  const drop = useRef(onDrop);
  drop.current = onDrop;
  // The click that follows the release of a drag is not a click on the card.
  const clickEndsDrag = useRef(false);
  const release = useRef<() => void>(undefined);
  useEffect(() => () => release.current?.(), []);

  const press = (e: ReactPointerEvent<HTMLElement>, card: string) => {
    if (e.button !== 0) return;
    release.current?.();
    const from = { x: e.clientX, y: e.clientY };
    const pointer = e.pointerId;
    const target = e.currentTarget;
    let phase: Phase = "pressed";
    let over: BoardViewColumn | undefined;

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointer || phase === "given up") return;
      if (phase === "pressed") {
        if (!isCardDrag(from, { x: ev.clientX, y: ev.clientY })) return;
        phase = "dragging";
        target.setPointerCapture(pointer);
      }
      const column = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(`[${BOARD_COLUMN_ATTRIBUTE}]`);
      over = columnNamed(column?.getAttribute(BOARD_COLUMN_ATTRIBUTE));
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
