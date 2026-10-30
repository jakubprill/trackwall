/**
 * Alt+N (⌥N on macOS) writes down an idea from any view (ADR-133): an idea is lost when writing it costs more than a few
 * seconds, so one key opens a line for it over whatever the window shows. Matched by position (`code`), like the session
 * shortcuts (`session-shortcut.ts`), and on macOS not when Option types an ASCII character there.
 */
type KeyPress = Pick<KeyboardEvent, "code" | "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">;

const PRINTABLE_ASCII = /^[\x20-\x7e]$/;

export function isIdeaShortcut(press: KeyPress, isMac: boolean): boolean {
  if (!press.altKey || press.ctrlKey || press.metaKey || press.shiftKey) return false;
  if (isMac && PRINTABLE_ASCII.test(press.key)) return false;
  return press.code === "KeyN";
}

/** The label in the system's convention. */
export function ideaShortcutLabel(isMac: boolean): string {
  return isMac ? "⌥N" : "Alt+N";
}
