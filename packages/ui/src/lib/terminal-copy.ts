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

/**
 * Copilot CLI asks for every mouse move (mode 1003), and xterm.js clears the selection on any input it sends to the
 * program, mouse reports included. A selection forced with Shift or Option was gone as soon as the mouse moved on to
 * copy it, so while text is selected and moves are reported, a move without a pressed button stays in the window. A
 * click or a drag still goes to the program, which also ends the selection.
 */
export function keepsSelection(
  move: Pick<MouseEvent, "buttons">,
  { hasSelection, reportsMoves }: { hasSelection: boolean; reportsMoves: boolean },
): boolean {
  return hasSelection && reportsMoves && move.buttons === 0;
}
