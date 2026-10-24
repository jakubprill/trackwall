/**
 * Files and folders dropped on the Tauri window (ADR-51). The shell hands the page full paths and a point; the page
 * sends a `FileDropEvent` to the element under that point, so the nearest target in the DOM wins: a session terminal
 * pastes the paths, and a drop that no target takes is a folder for the repo list.
 */

/** Marks an element that takes dropped paths; the hovered one gets `data-drop-hover` for its highlight. */
export const FILE_DROP_TARGET = "data-file-drop";
export const DROP_HOVER = "data-drop-hover";

export class FileDropEvent extends Event {
  static readonly type = "trackwall:file-drop";
  readonly paths: readonly string[];

  constructor(paths: readonly string[]) {
    // Cancelable: the target that takes the paths calls `preventDefault`, so the page knows nobody else should.
    super(FileDropEvent.type, { bubbles: true, cancelable: true });
    this.paths = paths;
  }
}

/** The shell reports the point in physical pixels of the webview; the DOM works in CSS pixels. */
export function cssPoint(physical: { x: number; y: number }, devicePixelRatio: number): { x: number; y: number } {
  return { x: physical.x / devicePixelRatio, y: physical.y / devicePixelRatio };
}

/** The drop target at a point: the element marked with `FILE_DROP_TARGET` that holds it, if any. */
export function dropTargetAt(doc: Pick<Document, "elementFromPoint">, point: { x: number; y: number }): Element | undefined {
  return doc.elementFromPoint(point.x, point.y)?.closest(`[${FILE_DROP_TARGET}]`) ?? undefined;
}

/**
 * Paths as typed into a session: separated by spaces and followed by one, so the user can keep typing, like a file
 * dropped on a system terminal. A path with a space or a quote goes in double quotes, with `"` escaped, because
 * the agent reads the line as words.
 */
export function pastedPaths(paths: readonly string[]): string {
  return `${paths.map((path) => (/[\s"']/.test(path) ? `"${path.replaceAll('"', '\\"')}"` : path)).join(" ")} `;
}
