/**
 * Skróty widoków z paska widoków: Ctrl + klawisz, na macOS ⌘ + klawisz, bez Shift i Alt.
 * Cyfry są rozpoznawane po klawiszu (`code`), bo na AZERTY cyfra bez Shift daje inny znak; z klawiatury numerycznej
 * tylko przy włączonym NumLock, bo bez niego te klawisze to End, PageUp itd. Przecinek po znaku (`key`), bo w innych
 * układach (AZERTY, Dvorak) leży na innym klawiszu, a na jego miejscu bywa litera z własnym skrótem. W układach, w których
 * przecinek wymaga Shift (cyrylica), ustawień nie otworzy skrót, tylko ikona.
 */
export type ViewShortcut = "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | ",";

type KeyPress = Pick<KeyboardEvent, "code" | "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">;

export function matchesShortcut(press: KeyPress, shortcut: ViewShortcut, isMac: boolean): boolean {
  const modifier = isMac ? press.metaKey && !press.ctrlKey : press.ctrlKey && !press.metaKey;
  const key =
    shortcut === ","
      ? press.key === ","
      : press.code === `Digit${shortcut}` || (press.code === `Numpad${shortcut}` && press.key === shortcut);
  return modifier && !press.altKey && !press.shiftKey && key;
}

/** Podpis skrótu w konwencji systemu: `⌘1` na macOS, `Ctrl+1` gdzie indziej. */
export function shortcutLabel(shortcut: ViewShortcut, isMac: boolean): string {
  return isMac ? `⌘${shortcut}` : `Ctrl+${shortcut}`;
}

/** Wartość `aria-keyshortcuts` (nazwy modyfikatorów z WAI-ARIA). */
export function ariaShortcut(shortcut: ViewShortcut, isMac: boolean): string {
  return `${isMac ? "Meta" : "Control"}+${shortcut}`;
}
