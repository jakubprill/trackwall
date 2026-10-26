/**
 * Copying and pasting in a session terminal on Windows and Linux (ADR-26). xterm.js turns Ctrl+C and Ctrl+V into control
 * characters for the program and cancels the key, so the browser fires neither `copy` nor `paste`, the only events on
 * which xterm.js touches the clipboard. So, as in Windows Terminal: Ctrl+C with selected text and Ctrl+Shift+C copy the
 * selection, Ctrl+C without a selection goes to the session, and Ctrl+V and Ctrl+Shift+V paste. On macOS Cmd+C and Cmd+V,
 * which xterm.js passes to the browser, do that, and Ctrl+C and Ctrl+V stay keys for the program.
 */
type ClipboardKey = Pick<KeyboardEvent, "type" | "key" | "ctrlKey" | "altKey" | "metaKey">;

function ctrlWith(key: ClipboardKey, letter: string): boolean {
  return key.type === "keydown" && key.ctrlKey && !key.altKey && !key.metaKey && key.key.toLowerCase() === letter;
}

export function copiesSelection(key: ClipboardKey, { mac, hasSelection }: { mac: boolean; hasSelection: boolean }): boolean {
  return !mac && hasSelection && ctrlWith(key, "c");
}

/**
 * Whether the key is left to the browser, whose `paste` event xterm.js turns into pasted text (bracketed paste when the
 * program asks for it). Reading the clipboard ourselves would need a permission prompt in the web view.
 */
export function pastesClipboard(key: ClipboardKey, { mac }: { mac: boolean }): boolean {
  return !mac && ctrlWith(key, "v");
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
