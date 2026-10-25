import type { ITheme } from "@xterm/xterm";

/**
 * Session terminal colours from the `index.css` tokens (ADR-16): xterm.js takes colours as strings, so it reads them
 * from CSS properties, not from a palette of its own. The ANSI colours stay xterm.js defaults: the agent's TUI picks them itself.
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
