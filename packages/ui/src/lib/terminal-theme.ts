import type { ITheme } from "@xterm/xterm";

/** xterm.js parses theme colours itself, so a colour value rather than the CSS keyword `transparent`. */
const TRANSPARENT = "rgba(0, 0, 0, 0)";

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
 * with them, so without them it would paint in xterm.js's default palette next to the HUD. The background is
 * transparent, so the terminal takes the surface it sits on (the supervisor panel, a view) instead of being a dark box
 * in it; `allowTransparency` in `terminal-options.ts` and the `.xterm-viewport` rule in `index.css` go with it. `token`
 * reads a custom property's value.
 */
export function terminalTheme(token: (name: string) => string): ITheme {
  const ansi: Partial<Record<keyof typeof ANSI_TOKENS, string>> = {};
  for (const [colour, name] of Object.entries(ANSI_TOKENS)) ansi[colour as keyof typeof ANSI_TOKENS] = token(name);
  return {
    ...ansi,
    background: TRANSPARENT,
    foreground: token("--foreground"),
    cursor: token("--primary"),
    cursorAccent: token("--background"),
    selectionBackground: token("--accent"),
  };
}

/** The attribute the desktop shell sets on `<html>` once the window has its background effect (ADR-11). */
const WINDOW_EFFECT_ATTRIBUTE = "data-window-effect";

/**
 * The tokens of `root` as `terminalTheme` reads them, each colour in a form xterm.js parses. xterm.js parses only hex,
 * `rgb()` and `rgba()` itself, and any other colour through a canvas, which it refuses when the colour is not opaque, and
 * then silently paints its own default instead: the translucent `--secondary` (ANSI black, under Copilot CLI's prompt
 * box and the user's messages) and `--accent` (the selection) of a window with a background effect became xterm.js's
 * opaque grey. So every colour goes through a canvas here and reaches xterm.js as `rgb()` or `rgba()`.
 */
export function cssTokens(root: HTMLElement): (name: string) => string {
  const style = getComputedStyle(root);
  const colour = canvasColour();
  return (name) => colour(style.getPropertyValue(name).trim());
}

/** A CSS colour as `rgb()` or `rgba()`, read back from a canvas; anything the canvas does not take stays as it is. */
function canvasColour(): (css: string) => string {
  const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  return (css) => {
    if (!context || css === "" || !CSS.supports("color", css)) return css;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = css;
    context.fillRect(0, 0, 1, 1);
    const [red = 0, green = 0, blue = 0, alpha = 0] = context.getImageData(0, 0, 1, 1).data;
    return rgbColour(red, green, blue, alpha);
  };
}

/** Channels of 0–255 as xterm.js parses them: `rgb()` when opaque, otherwise `rgba()` with the alpha from 0 to 1. */
export function rgbColour(red: number, green: number, blue: number, alpha: number): string {
  if (alpha === 255) return `rgb(${red}, ${green}, ${blue})`;
  return `rgba(${red}, ${green}, ${blue}, ${Math.round((alpha / 255) * 1000) / 1000})`;
}

/**
 * Calls `changed` whenever the desktop shell sets or removes the window effect on `root`. The shell sets it after the
 * page has loaded, often after a terminal has opened, and the effect changes the tokens (`--fill-alpha`), so a terminal
 * reads its theme again then instead of keeping the opaque colours until it is opened anew. Returns the unsubscribe.
 */
export function watchWindowEffect(root: HTMLElement, changed: () => void): () => void {
  const observer = new MutationObserver(changed);
  observer.observe(root, { attributes: true, attributeFilter: [WINDOW_EFFECT_ATTRIBUTE] });
  return () => observer.disconnect();
}
