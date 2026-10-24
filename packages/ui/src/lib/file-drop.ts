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

/**
 * The drop point in CSS pixels. Tauri calls it physical, but only WebView2 on Windows gives physical pixels; on macOS
 * (and with GTK on Linux) wry hands over the system's own points, which already are CSS pixels.
 */
export function cssPoint(point: { x: number; y: number }, windows: boolean, devicePixelRatio: number): { x: number; y: number } {
  const scale = windows ? devicePixelRatio : 1;
  return { x: point.x / scale, y: point.y / scale };
}

/** The drop target at a point: the element marked with `FILE_DROP_TARGET` that holds it, if any. */
export function dropTargetAt(doc: Pick<Document, "elementFromPoint">, point: { x: number; y: number }): Element | undefined {
  return doc.elementFromPoint(point.x, point.y)?.closest(`[${FILE_DROP_TARGET}]`) ?? undefined;
}
