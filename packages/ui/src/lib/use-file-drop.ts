import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useRef, useState } from "react";
import { cssPoint, DROP_HOVER, type DroppedPaths, dragStep, dropTargetAt, FileDropEvent, pageZoom } from "./file-drop.ts";
import { IS_WINDOWS } from "./platform.ts";

/**
 * Listens to files dragged onto the Tauri window (ADR-51): marks the drop target under the pointer while dragging
 * and, on drop, sends it a `FileDropEvent`. A drop outside every target goes to `onUnhandled`, but only with the daemon
 * on this desktop (`local`, ADR-130): a folder of this computer means nothing to a daemon elsewhere, while a terminal
 * still takes files by sending copies (ADR-201). Returns whether files are being dragged over the window, for the hint
 * that names both, so also only with `local`; outside Tauri always `false`, because a browser gives the page no paths.
 */
export function useFileDrop(local: boolean, onUnhandled: (paths: DroppedPaths) => void): boolean {
  const [dragging, setDragging] = useState(false);
  const handler = useRef(onUnhandled);
  handler.current = onUnhandled;
  const isLocal = useRef(local);
  isLocal.current = local;

  useEffect(() => {
    if (!isTauri()) return;
    let hovered: Element | undefined;
    const hover = (next: Element | undefined) => {
      if (next === hovered) return;
      hovered?.removeAttribute(DROP_HOVER);
      next?.setAttribute(DROP_HOVER, "");
      hovered = next;
    };
    let carriesFiles = false;
    const unlisten = getCurrentWebview().onDragDropEvent(({ payload }) => {
      const step = dragStep(carriesFiles, payload);
      carriesFiles = step.carriesFiles;
      const { action } = step;
      if (action.kind === "stop") {
        hover(undefined);
        setDragging(false);
        return;
      }
      if (payload.type === "leave") return;
      const target = dropTargetAt(
        document,
        cssPoint(payload.position, {
          windows: IS_WINDOWS,
          devicePixelRatio: window.devicePixelRatio,
          zoom: pageZoom(document.documentElement),
        }),
      );
      if (action.kind === "hover") {
        hover(target);
        setDragging(isLocal.current);
        return;
      }
      hover(undefined);
      setDragging(false);
      if (target) target.dispatchEvent(new FileDropEvent(action.paths));
      else if (isLocal.current) handler.current(action.paths);
    });
    return () => {
      hover(undefined);
      void unlisten.then((unsubscribe) => unsubscribe());
    };
  }, []);

  return dragging;
}
