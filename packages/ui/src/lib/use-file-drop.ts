import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useRef, useState } from "react";
import { cssPoint, DROP_HOVER, dropTargetAt, FileDropEvent } from "./file-drop.ts";

/**
 * Listens to files dragged onto the Tauri window (ADR-51): marks the drop target under the pointer while dragging
 * and, on drop, sends a `FileDropEvent` to the element under the pointer. Paths that no target took go to
 * `onUnhandled`. Returns whether something is being dragged over the window; outside Tauri always `false`, because a
 * browser does not give the page full paths.
 */
export function useFileDrop(onUnhandled: (paths: readonly string[]) => void): boolean {
  const [dragging, setDragging] = useState(false);
  const handler = useRef(onUnhandled);
  handler.current = onUnhandled;

  useEffect(() => {
    if (!isTauri()) return;
    let hovered: Element | undefined;
    const hover = (next: Element | undefined) => {
      if (next === hovered) return;
      hovered?.removeAttribute(DROP_HOVER);
      next?.setAttribute(DROP_HOVER, "");
      hovered = next;
    };
    const unlisten = getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === "leave") {
        hover(undefined);
        setDragging(false);
        return;
      }
      const point = cssPoint(payload.position, window.devicePixelRatio);
      if (payload.type !== "drop") {
        hover(dropTargetAt(document, point));
        setDragging(true);
        return;
      }
      hover(undefined);
      setDragging(false);
      const event = new FileDropEvent(payload.paths);
      (document.elementFromPoint(point.x, point.y) ?? document.body).dispatchEvent(event);
      if (!event.defaultPrevented && payload.paths.length > 0) handler.current(payload.paths);
    });
    return () => {
      hover(undefined);
      void unlisten.then((stop) => stop());
    };
  }, []);

  return dragging;
}
