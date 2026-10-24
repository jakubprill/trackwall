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
  return withModifier(press, isMac, false) && matchesKey(press, shortcut);
}

/**
 * A view's key with Ctrl+Shift opens the view in a new window (ADR-49): Ctrl+Shift+2 opens Repos. On macOS it is ⌥⌘,
 * because ⌘⇧3 and ⌘⇧4 are the system's screenshot shortcuts and never reach the app. Settings has no such shortcut:
 * Shift and Option change the comma on most layouts.
 */
export function matchesNewWindowShortcut(press: KeyPress, shortcut: ViewShortcut, isMac: boolean): boolean {
  if (shortcut === ",") return false;
  const modifiers = isMac
    ? press.metaKey && press.altKey && !press.ctrlKey && !press.shiftKey
    : press.ctrlKey && press.shiftKey && !press.altKey && !press.metaKey;
  return modifiers && matchesKey(press, shortcut);
}

/** Ctrl+Shift+N (⌘⇧N) opens the current view in a new window; the letter by character, like in every layout's menus. */
function isNewWindowShortcut(press: KeyPress, isMac: boolean): boolean {
  return withModifier(press, isMac, true) && press.key.toLowerCase() === "n";
}

/** What a key press does on the activity bar: switch this window's view or open a view in a new window. */
export type ViewKeyAction<Id extends string> = { kind: "select" | "new-window"; id: Id };

/**
 * The action of a key press; new-window shortcuts only where windows can be opened, and not for a held key, whose
 * autorepeat would open a window per repeat.
 */
export function viewKeyAction<Id extends string>(
  press: KeyPress & Pick<KeyboardEvent, "repeat">,
  views: readonly { id: Id; shortcut: ViewShortcut }[],
  active: Id,
  { isMac, newWindows }: { isMac: boolean; newWindows: boolean },
): ViewKeyAction<Id> | undefined {
  const view = views.find((v) => matchesShortcut(press, v.shortcut, isMac));
  if (view) return { kind: "select", id: view.id };
  if (!newWindows || press.repeat) return undefined;
  if (isNewWindowShortcut(press, isMac)) return { kind: "new-window", id: active };
  const inNewWindow = views.find((v) => matchesNewWindowShortcut(press, v.shortcut, isMac));
  return inNewWindow && { kind: "new-window", id: inNewWindow.id };
}

function withModifier(press: KeyPress, isMac: boolean, shift: boolean): boolean {
  const modifier = isMac ? press.metaKey && !press.ctrlKey : press.ctrlKey && !press.metaKey;
  return modifier && !press.altKey && press.shiftKey === shift;
}

function matchesKey(press: KeyPress, shortcut: ViewShortcut): boolean {
  return shortcut === ","
    ? press.key === ","
    : press.code === `Digit${shortcut}` || (press.code === `Numpad${shortcut}` && press.key === shortcut);
}

/** Podpis skrótu w konwencji systemu: `⌘1` na macOS, `Ctrl+1` gdzie indziej. */
export function shortcutLabel(shortcut: ViewShortcut, isMac: boolean): string {
  return isMac ? `⌘${shortcut}` : `Ctrl+${shortcut}`;
}

/** Wartość `aria-keyshortcuts` (nazwy modyfikatorów z WAI-ARIA). */
export function ariaShortcut(shortcut: ViewShortcut, isMac: boolean): string {
  return `${isMac ? "Meta" : "Control"}+${shortcut}`;
}
