import type { ITheme } from "@xterm/xterm";

/** The ANSI colours of `ITheme` and the `index.css` token each one reads. */
export const ANSI_TOKENS = {
  black: "--ansi-black",
  red: "--ansi-red",
  green: "--ansi-green",
  yellow: "--ansi-yellow",
  blue: "--ansi-blue",
  magenta: "--ansi-magenta",
  cyan: "--ansi-cyan",
  white: "--ansi-white",
  brightBlack: "--ansi-bright-black",
  brightRed: "--ansi-bright-red",
  brightGreen: "--ansi-bright-green",
  brightYellow: "--ansi-bright-yellow",
  brightBlue: "--ansi-bright-blue",
  brightMagenta: "--ansi-bright-magenta",
  brightCyan: "--ansi-bright-cyan",
  brightWhite: "--ansi-bright-white",
} as const satisfies Partial<Record<keyof ITheme, string>>;

/**
 * Session terminal colours from the `index.css` tokens (ADR-16): xterm.js takes colours as strings, so it reads them
 * from CSS properties, not from a palette of its own. The 16 ANSI colours are tokens too: Copilot CLI draws its TUI
 * with them, so without them it would paint in xterm.js's default palette next to the HUD. `token` reads a custom
 * property's value.
 */
export function terminalTheme(token: (name: string) => string): ITheme {
  const ansi: Partial<Record<keyof typeof ANSI_TOKENS, string>> = {};
  for (const [colour, name] of Object.entries(ANSI_TOKENS)) ansi[colour as keyof typeof ANSI_TOKENS] = token(name);
  return {
    ...ansi,
    background: token("--background"),
    foreground: token("--foreground"),
    cursor: token("--primary"),
    cursorAccent: token("--background"),
    selectionBackground: token("--accent"),
  };
}

/** The tokens of `root` as `terminalTheme` reads them. */
export function cssTokens(root: HTMLElement): (name: string) => string {
  const style = getComputedStyle(root);
  return (name) => style.getPropertyValue(name).trim();
}
