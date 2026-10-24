/**
 * Kopiowanie z terminala sesji na Windowsie (ADR-26). xterm.js zamienia Ctrl+C na znak przerwania dla programu,
 * a kopiuje tylko na zdarzenie `copy` przeglądarki, którego Ctrl+C w terminalu nie wywołuje. Dlatego tak jak w Windows
 * Terminal: Ctrl+C z zaznaczonym tekstem i Ctrl+Shift+C kopiują zaznaczenie, a Ctrl+C bez zaznaczenia idzie do sesji.
 * Na macOS kopiuje Cmd+C, które xterm.js przepuszcza do przeglądarki, a Ctrl+C zostaje przerwaniem.
 */
export interface KeyPress {
  type: string;
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export function copiesSelection(e: KeyPress, o: { mac: boolean; hasSelection: boolean }): boolean {
  if (o.mac || !o.hasSelection || e.type !== "keydown") return false;
  return e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === "c";
}
