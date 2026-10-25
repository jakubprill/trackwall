/**
 * Copying from a session terminal on Windows (ADR-26). xterm.js turns Ctrl+C into the interrupt character for the
 * program and copies only on the browser's `copy` event, which Ctrl+C in the terminal does not trigger. So, as in Windows
 * Terminal: Ctrl+C with selected text and Ctrl+Shift+C copy the selection, and Ctrl+C without a selection goes to the session.
 * On macOS Cmd+C copies, which xterm.js passes to the browser, and Ctrl+C stays the interrupt.
 */
type CopyKey = Pick<KeyboardEvent, "type" | "key" | "ctrlKey" | "altKey" | "metaKey">;

export function copiesSelection(key: CopyKey, { mac, hasSelection }: { mac: boolean; hasSelection: boolean }): boolean {
  if (mac || !hasSelection || key.type !== "keydown") return false;
  return key.ctrlKey && !key.altKey && !key.metaKey && key.key.toLowerCase() === "c";
}
