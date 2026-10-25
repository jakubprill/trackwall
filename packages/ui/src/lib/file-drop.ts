import { z } from "zod";

/**
 * Files and folders dropped on the Tauri window (ADR-51). The shell hands the page full paths and a point; the drop
 * target that holds the point (a session terminal) gets a `FileDropEvent` with the paths, and a drop outside every
 * target is a folder for the repo list. The same rule picks the target that is highlighted while dragging.
 */

/** Marks an element that takes dropped paths. */
export const FILE_DROP_TARGET = "data-file-drop";
/** Set on the target under the pointer while dragging. */
export const DROP_HOVER = "data-drop-hover";
/** The highlight of the target under the pointer; Tailwind needs the attribute spelled out, the test pins it to `DROP_HOVER`. */
export const DROP_HOVER_RING = "data-[drop-hover]:ring-primary data-[drop-hover]:ring-2 data-[drop-hover]:ring-inset";

/** What was dropped, at least one full path. */
export type DroppedPaths = readonly [string, ...string[]];

export class FileDropEvent extends Event {
  static readonly type = "trackwall:file-drop";
  readonly paths: readonly string[];

  constructor(paths: readonly string[]) {
    super(FileDropEvent.type);
    this.paths = paths;
  }
}

/** The attribute with the window's zoom that the shell sets on the page's root (`ZOOM_ATTRIBUTE` in `zoom.rs`, ADR-65). */
const ZOOM_ATTRIBUTE = "data-zoom";

const Zoom = z.coerce.number().positive().finite();

/** The window's zoom from the shell's attribute; 1 without it (a browser, or before the shell has set it). */
export function pageZoom(root: Pick<Element, "getAttribute">): number {
  const zoom = Zoom.safeParse(root.getAttribute(ZOOM_ATTRIBUTE) ?? undefined);
  return zoom.success ? zoom.data : 1;
}

/**
 * The drop point in CSS pixels. Tauri calls it physical, but only WebView2 on Windows gives physical pixels, and its
 * device pixel ratio includes the zoom; on macOS (and with GTK on Linux) wry hands over the system's own points,
 * which are CSS pixels only at actual size, so they are divided by the window's zoom.
 */
export function cssPoint(
  point: { x: number; y: number },
  { windows, devicePixelRatio, zoom }: { windows: boolean; devicePixelRatio: number; zoom: number },
): { x: number; y: number } {
  const scale = windows ? devicePixelRatio : zoom;
  return { x: point.x / scale, y: point.y / scale };
}

/** The drop target at a point: the element marked with `FILE_DROP_TARGET` that holds it, if any. */
export function dropTargetAt(doc: Pick<Document, "elementFromPoint">, point: { x: number; y: number }): Element | undefined {
  return doc.elementFromPoint(point.x, point.y)?.closest(`[${FILE_DROP_TARGET}]`) ?? undefined;
}

/** What the shell reports while dragging over the window (Tauri's `DragDropEvent`, without the point). */
export type DragPayload =
  | { type: "enter"; paths: readonly string[] }
  | { type: "over" }
  | { type: "drop"; paths: readonly string[] }
  | { type: "leave" };

/**
 * One step of a drag over the window: whether it still carries files and what to do now. A drag of text, a link or an
 * image carries no paths, so it shows neither the hint nor a highlight and its drop does nothing.
 */
export function dragStep(
  carriesFiles: boolean,
  payload: DragPayload,
): { carriesFiles: boolean; action: { kind: "stop" } | { kind: "hover" } | { kind: "drop"; paths: DroppedPaths } } {
  const files = payload.type === "enter" ? payload.paths.length > 0 : carriesFiles;
  if (payload.type === "leave" || !files) return { carriesFiles: false, action: { kind: "stop" } };
  if (payload.type !== "drop") return { carriesFiles: true, action: { kind: "hover" } };
  const [first, ...rest] = payload.paths;
  if (first === undefined) return { carriesFiles: false, action: { kind: "stop" } };
  return { carriesFiles: false, action: { kind: "drop", paths: [first, ...rest] } };
}
