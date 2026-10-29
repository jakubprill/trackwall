import { useCallback, useRef, useState } from "react";
import type { TaskSection } from "./task-notices.ts";

/**
 * What lies over a task tile's terminal (ADR-91): all of the task's sections (scrolled to one), only its mise config to
 * trust, or the task menu. One at a time, so that opening one closes the other and Escape closes what the user sees.
 */
export type TileOverlayContent = { kind: "notices"; section?: TaskSection } | { kind: "mise-config" } | { kind: "menu" };

/**
 * The overlay a task tile shows, and where the keyboard goes when it closes: the chip, badge or menu button registered
 * for its kind (`trigger`), else the menu button, since a button inside a closed overlay or a banner is gone by then.
 */
export function useTileOverlay() {
  const [opened, setOpened] = useState<TileOverlayContent>();
  const triggers = useRef(new Map<TileOverlayContent["kind"], HTMLElement>());
  const trigger = useCallback(
    (kind: TileOverlayContent["kind"]) => (element: HTMLElement | null) => {
      if (element) triggers.current.set(kind, element);
      else triggers.current.delete(kind);
    },
    [],
  );
  const close = () => {
    const kind = opened?.kind;
    setOpened(undefined);
    const target = (kind && triggers.current.get(kind)) ?? triggers.current.get("menu");
    target?.focus();
  };
  return { opened, open: setOpened, close, trigger };
}

export type TileOverlay = ReturnType<typeof useTileOverlay>;
