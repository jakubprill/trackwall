import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useRef, useState } from "react";
import { cssPoint, DROP_HOVER, type DroppedPaths, dropTargetAt, FileDropEvent } from "./file-drop.ts";
import { IS_WINDOWS } from "./platform.ts";

/**
 * Listens to files dragged onto the Tauri window (ADR-51): marks the drop target under the pointer while dragging
 * and, on drop, sends it a `FileDropEvent`. A drop outside every target goes to `onUnhandled`. Returns whether files
 * are being dragged over the window; outside Tauri always `false`, because a browser does not give the page full paths.
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
    // A drag of text, a link or an image carries no paths; it shows neither the hint nor a highlight.
    let dragActive = false;
    const stop = () => {
      dragActive = false;
      hover(undefined);
      setDragging(false);
    };
    const deliver = (paths: readonly string[], target: Element | undefined) => {
      const [first, ...rest] = paths;
      if (first === undefined) return;
      if (target) target.dispatchEvent(new FileDropEvent(paths));
      else handler.current([first, ...rest]);
    };
    const unlisten = getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === "enter") dragActive = payload.paths.length > 0;
      if (payload.type === "leave" || !dragActive) return stop();
      const target = dropTargetAt(document, cssPoint(payload.position, IS_WINDOWS, window.devicePixelRatio));
      if (payload.type !== "drop") {
        hover(target);
        setDragging(true);
        return;
      }
      stop();
      deliver(payload.paths, target);
    });
    return () => {
      hover(undefined);
      void unlisten.then((unsubscribe) => unsubscribe());
    };
  }, []);

  return dragging;
}
