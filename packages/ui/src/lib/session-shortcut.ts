/**
 * Session shortcuts (ADR-48): Alt + digit (⌥ on macOS) selects the entry at that position in the Sessions list, and
 * Alt+J opens the next session that is waiting for you. Ctrl/⌘ + digit already switches views, and Ctrl+J is a line
 * feed in a terminal, so sessions get their own modifier. Keys are matched by position (`code`), because on macOS
 * Option + key types a character (`¡`, `∆`) and on AZERTY a digit without Shift is another character. Characters that
 * Alt or Option exists to type stay keys, not shortcuts: AltGr on Windows (it reports Ctrl + Alt), Alt + keypad digits
 * (a character by its code on Windows) and, on macOS, Option + key that types an ASCII character, like `[` and `{`
 * from ⌥5 and ⌥8 on a German layout.
 */
export type SessionShortcut = { kind: "position"; position: number } | { kind: "next-waiting" };

type KeyPress = Pick<KeyboardEvent, "code" | "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">;

/** The highest position a shortcut reaches; the list can be longer. */
export const SHORTCUT_POSITIONS = 9;

const DIGIT_CODE = /^Digit([1-9])$/;
const PRINTABLE_ASCII = /^[\x20-\x7e]$/;

export function sessionShortcut(press: KeyPress, isMac: boolean): SessionShortcut | undefined {
  if (!press.altKey || press.ctrlKey || press.metaKey || press.shiftKey) return undefined;
  if (isMac && PRINTABLE_ASCII.test(press.key)) return undefined;
  if (press.code === "KeyJ") return { kind: "next-waiting" };
  const digit = DIGIT_CODE.exec(press.code)?.[1];
  return digit === undefined ? undefined : { kind: "position", position: Number(digit) };
}

/** The label of a shortcut, `⌥1` on macOS and `Alt+1` elsewhere; a position past the last one has none. */
export function sessionShortcutLabel(shortcut: SessionShortcut, isMac: boolean): string | undefined {
  if (shortcut.kind === "position" && (shortcut.position < 1 || shortcut.position > SHORTCUT_POSITIONS)) return undefined;
  const key = shortcut.kind === "position" ? String(shortcut.position) : "J";
  return isMac ? `⌥${key}` : `Alt+${key}`;
}

/** The `aria-keyshortcuts` value: WAI-ARIA names Option `Alt` on macOS too. */
export function ariaSessionShortcut(shortcut: SessionShortcut): string | undefined {
  if (shortcut.kind === "next-waiting") return "Alt+J";
  return shortcut.position >= 1 && shortcut.position <= SHORTCUT_POSITIONS ? `Alt+${shortcut.position}` : undefined;
}
