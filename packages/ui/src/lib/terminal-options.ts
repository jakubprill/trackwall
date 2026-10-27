import type { ITerminalOptions, ITheme } from "@xterm/xterm";

/**
 * Settings of the session terminal window (ADR-26). Copilot CLI takes over the mouse, so a plain drag goes to the TUI
 * instead of selecting text. Selection is forced with Shift on Windows (the xterm.js default) and Option on macOS, which
 * has to be turned on in xterm.js separately. Copying: Cmd+C on macOS, Ctrl+C with a selection elsewhere; pasting:
 * Cmd+V on macOS, Ctrl+V elsewhere (`terminal-copy.ts`). Line height stays xterm.js's 1: more spacing costs rows, and on a
 * small screen a task's terminal then no longer shows Copilot CLI's whole approval dialog (`task-small-screen.e2e.ts`).
 */
export function sessionTerminalOptions(theme: ITheme, fontFamily: string): ITerminalOptions {
  return {
    theme,
    fontFamily,
    fontSize: 13,
    cursorBlink: true,
    allowTransparency: true,
    scrollback: 5000,
    allowProposedApi: false,
    macOptionClickForcesSelection: true,
  };
}
