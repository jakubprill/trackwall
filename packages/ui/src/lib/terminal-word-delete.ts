/**
 * Ctrl+Backspace in a session terminal deletes the word before the cursor, as in every text field on Windows. xterm.js
 * sends Ctrl+Backspace as `^H`, which Copilot CLI reads as a plain Backspace, so it deleted one character. Copilot CLI
 * deletes a word on `^W` (and on Alt+Backspace, `ESC DEL`, which xterm.js already sends), so the session terminal sends
 * `^W` instead; the contract test `copilot-line-editing.contract.ts` holds Copilot CLI to it. Only for Copilot CLI: in
 * a folder terminal's shell `^H` stays, because on Windows ConPTY turns it into Ctrl+Backspace, which PowerShell and
 * `cmd.exe` already read as "delete a word", while `^W` means nothing to them.
 */

type WordDeleteKey = Pick<KeyboardEvent, "type" | "key" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey">;

/** Ctrl+W: "delete the word before the cursor" in Copilot CLI's input box, as in readline. */
export const DELETE_WORD_BEFORE = "\x17";

/** Whether the key is Ctrl+Backspace alone, which the session terminal sends as `DELETE_WORD_BEFORE`. */
export function deletesWordBefore(key: WordDeleteKey): boolean {
  return key.type === "keydown" && key.key === "Backspace" && key.ctrlKey && !key.altKey && !key.metaKey && !key.shiftKey;
}
