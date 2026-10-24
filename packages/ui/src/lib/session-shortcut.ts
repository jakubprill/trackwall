/**
 * Session shortcuts in the Sessions view (ADR-48): Alt + digit (⌥ on macOS) focuses the session at that position in
 * the list, Alt+J jumps to the next session that is waiting for you. Ctrl/⌘ + digit already switches views, and Ctrl+J
 * is a line feed in the terminal, so sessions get their own modifier. Keys are matched by position (`code`), because
 * on macOS Option + key types a character (`¡`, `∆`) and on AZERTY a digit without Shift is another character. The
 * numeric keypad does not count: on Windows Alt + keypad digits type a character by its code.
 */
export type SessionShortcut = { kind: "position"; position: number } | { kind: "next-waiting" };

type KeyPress = Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">;

/** The highest position a shortcut reaches; the list can be longer. */
const SHORTCUT_POSITIONS = 9;

const DIGIT_CODE = /^Digit([1-9])$/;

export function sessionShortcut(press: KeyPress): SessionShortcut | undefined {
  // AltGr on Windows reports Ctrl + Alt, so a Polish or German character typed with AltGr is not a shortcut.
  if (!press.altKey || press.ctrlKey || press.metaKey || press.shiftKey) return undefined;
  if (press.code === "KeyJ") return { kind: "next-waiting" };
  const digit = DIGIT_CODE.exec(press.code)?.[1];
  return digit === undefined ? undefined : { kind: "position", position: Number(digit) };
}

/** The label of a position shortcut, `⌥1` on macOS and `Alt+1` elsewhere; `undefined` past the last position. */
export function positionShortcutLabel(position: number, isMac: boolean): string | undefined {
  if (position < 1 || position > SHORTCUT_POSITIONS) return undefined;
  return isMac ? `⌥${position}` : `Alt+${position}`;
}

export function nextWaitingShortcutLabel(isMac: boolean): string {
  return isMac ? "⌥J" : "Alt+J";
}

/** `aria-keyshortcuts` values (WAI-ARIA names Option `Alt` on macOS too). */
export function ariaPositionShortcut(position: number): string | undefined {
  return position >= 1 && position <= SHORTCUT_POSITIONS ? `Alt+${position}` : undefined;
}

export const ARIA_NEXT_WAITING_SHORTCUT = "Alt+J";
