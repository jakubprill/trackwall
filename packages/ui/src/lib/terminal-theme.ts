import type { ITheme } from "@xterm/xterm";

/**
 * Kolory terminala sesji z tokenów `index.css` (ADR-16): xterm.js przyjmuje kolory jako napisy, więc czyta je
 * z właściwości CSS, a nie z własnej palety. Kolory ANSI zostają domyślne xterm.js: TUI agenta dobiera je sam.
 */
export function terminalTheme(root: HTMLElement): ITheme {
  const style = getComputedStyle(root);
  const token = (name: string) => style.getPropertyValue(name).trim();
  return {
    background: token("--background"),
    foreground: token("--foreground"),
    cursor: token("--primary"),
    cursorAccent: token("--background"),
    selectionBackground: token("--accent"),
  };
}
