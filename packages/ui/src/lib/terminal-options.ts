import type { ITerminalOptions, ITheme } from "@xterm/xterm";

/**
 * Ustawienia okna terminala sesji (ADR-26). Copilot CLI przejmuje mysz, więc zwykłe przeciągnięcie trafia do TUI,
 * a nie zaznacza tekstu. Zaznaczenie wymusza Shift na Windowsie (domyślnie w xterm.js) i Option na macOS, które
 * xterm.js trzeba włączyć osobno.
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
