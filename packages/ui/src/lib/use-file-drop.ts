import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useRef, useState } from "react";
import { cssPoint, DROP_HOVER, type DroppedPaths, dropTargetAt, FileDropEvent } from "./file-drop.ts";

/**
 * Listens to files dragged onto the Tauri window (ADR-51): marks the drop target under the pointer while dragging
 * and, on drop, sends it a `FileDropEvent`. A drop outside every target goes to `onUnhandled`. Returns whether something is being dragged over the window; outside Tauri always `false`, because a
 * browser does not give the page full paths.
 */
export function useFileDrop(onUnhandled: (paths: DroppedPaths) => void): boolean {
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
      const [first, ...rest] = payload.paths;
      if (first === undefined) return;
      const target = dropTargetAt(document, point);
      if (target) target.dispatchEvent(new FileDropEvent(payload.paths));
      else handler.current([first, ...rest]);
    });
    return () => {
      hover(undefined);
      void unlisten.then((stop) => stop());
    };
  }, []);

  return dragging;
}
