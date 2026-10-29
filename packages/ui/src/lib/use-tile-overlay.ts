import { useCallback, useRef, useState } from "react";
import type { TaskSection } from "./task-notices.ts";

/**
 * What lies over a task tile's terminal (ADR-91): all of the task's sections (scrolled to one), only its mise config to
 * trust, or the task menu. One at a time, so that opening one closes the other and Escape closes what the user sees.
 */
export type TileOverlayContent = { kind: "notices"; section?: TaskSection } | { kind: "mise-config" } | { kind: "menu" };

/**
 * The overlay a task tile shows, and where the keyboard goes when it closes: the chip, badge or menu button registered
 * for that content (`trigger`), else the one for its kind (the badge for the notices), else the menu button, since a
 * button inside a closed overlay or a banner is gone by then.
 */
export function useTileOverlay() {
  const [opened, setOpened] = useState<TileOverlayContent>();
  const triggers = useRef(new Map<string, HTMLElement>());
  const trigger = useCallback(
    (content: TileOverlayContent) => (element: HTMLElement | null) => {
      if (element) triggers.current.set(contentKey(content), element);
      else triggers.current.delete(contentKey(content));
    },
    [],
  );
  const close = () => {
    const found = opened && (triggers.current.get(contentKey(opened)) ?? triggers.current.get(opened.kind));
    const target = found ?? triggers.current.get("menu");
    setOpened(undefined);
    target?.focus();
  };
  return { opened, open: setOpened, close, trigger };
}

/** The notices at a section are their own content, so that the chip that opened them gets the keyboard back. */
function contentKey(content: TileOverlayContent): string {
  return content.kind === "notices" && content.section ? `notices:${content.section}` : content.kind;
}

export type TileOverlay = ReturnType<typeof useTileOverlay>;
