/**
 * Kopiowanie z terminala sesji na Windowsie (ADR-26). xterm.js zamienia Ctrl+C na znak przerwania dla programu,
 * a kopiuje tylko na zdarzenie `copy` przeglądarki, którego Ctrl+C w terminalu nie wywołuje. Dlatego tak jak w Windows
 * Terminal: Ctrl+C z zaznaczonym tekstem i Ctrl+Shift+C kopiują zaznaczenie, a Ctrl+C bez zaznaczenia idzie do sesji.
 * Na macOS kopiuje Cmd+C, które xterm.js przepuszcza do przeglądarki, a Ctrl+C zostaje przerwaniem.
 */
type CopyKey = Pick<KeyboardEvent, "type" | "key" | "ctrlKey" | "altKey" | "metaKey">;

export function copiesSelection(key: CopyKey, { mac, hasSelection }: { mac: boolean; hasSelection: boolean }): boolean {
  if (mac || !hasSelection || key.type !== "keydown") return false;
  return key.ctrlKey && !key.altKey && !key.metaKey && key.key.toLowerCase() === "c";
}
