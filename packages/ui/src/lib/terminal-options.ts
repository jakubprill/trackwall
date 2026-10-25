import type { ITerminalOptions, ITheme } from "@xterm/xterm";

/**
 * Settings of the session terminal window (ADR-26). Copilot CLI takes over the mouse, so a plain drag goes to the TUI
 * instead of selecting text. Selection is forced with Shift on Windows (the xterm.js default) and Option on macOS, which
 * has to be turned on in xterm.js separately. Copying: Cmd+C on macOS, Ctrl+C with a selection on Windows (`terminal-copy.ts`).
 */
export function sessionTerminalOptions(theme: ITheme, fontFamily: string): ITerminalOptions {
  return {
    theme,
    fontFamily,
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: false,
    macOptionClickForcesSelection: true,
  };
}
