/**
 * Skróty widoków z paska widoków: Ctrl + klawisz, na macOS ⌘ + klawisz, bez Shift i Alt.
 * Klawisz jest rozpoznawany po `code` (fizycznym miejscu na klawiaturze), więc działa tak samo w każdym układzie.
 */
export type ViewShortcut = {
  /** `KeyboardEvent.code`, np. `Digit1` albo `Comma`. */
  code: string;
  /** To, co widać na klawiszu, do podpowiedzi. */
  key: string;
};

type KeyPress = Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">;

export function matchesShortcut(press: KeyPress, shortcut: ViewShortcut, isMac: boolean): boolean {
  const modifier = isMac ? press.metaKey && !press.ctrlKey : press.ctrlKey && !press.metaKey;
  return modifier && !press.altKey && !press.shiftKey && press.code === shortcut.code;
}

/** Podpis skrótu w konwencji systemu: `⌘1` na macOS, `Ctrl+1` gdzie indziej. */
export function shortcutLabel(shortcut: ViewShortcut, isMac: boolean): string {
  return isMac ? `⌘${shortcut.key}` : `Ctrl+${shortcut.key}`;
}

/** Wartość `aria-keyshortcuts` (nazwy modyfikatorów z WAI-ARIA). */
export function ariaShortcut(shortcut: ViewShortcut, isMac: boolean): string {
  return `${isMac ? "Meta" : "Control"}+${shortcut.key}`;
}
