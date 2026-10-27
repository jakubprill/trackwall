/**
 * Copying and pasting in a session terminal on Windows and Linux (ADR-26). xterm.js turns Ctrl+C and Ctrl+V into control
 * characters for the program and cancels the key, so the browser fires neither `copy` nor `paste`, the only events on
 * which xterm.js touches the clipboard. So, as in Windows Terminal: Ctrl+C with selected text and Ctrl+Shift+C copy the
 * selection, Ctrl+C without a selection goes to the session, and Ctrl+V and Ctrl+Shift+V paste. On macOS Cmd+C and Cmd+V,
 * which xterm.js passes to the browser, do that, and Ctrl+C and Ctrl+V stay keys for the program. A program that draws its
 * own selection, as Copilot CLI does, copies it itself (`osc52Text`).
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

/**
 * Copilot CLI takes the mouse and draws its own selection, which xterm.js does not know about, and on Ctrl+C or a right
 * click it copies that text by sending OSC 52 (`ESC ] 52 ; c ; <base64> BEL`), as a program does over SSH. xterm.js
 * ignores the sequence unless told otherwise. This is the text to copy from the sequence's data (`c;<base64>`), or
 * `undefined` when the data does not set the clipboard: another target only (Copilot CLI sends `p!` on mouse release), a
 * query (`?`, never answered, so a program cannot read the clipboard), an empty payload, or bytes that are not base64
 * of UTF-8 text. No target means the clipboard, as in xterm.
 */
export function osc52Text(data: string): string | undefined {
  const split = data.indexOf(";");
  if (split < 0) return undefined;
  const targets = data.slice(0, split);
  // Copilot CLI ends its `p!` payload with a `;`; one more on the clipboard target would not break the copy.
  const payload = data.slice(split + 1).replace(/;$/, "");
  if ((targets !== "" && !targets.includes("c")) || payload === "" || payload === "?") return undefined;
  try {
    const bytes = Uint8Array.from(atob(payload), (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** How long after the user asks Copilot CLI to copy (`asksProgramToCopy`) its OSC 52 still counts; it answers in milliseconds. */
const PROGRAM_COPY_MS = 1000;

/**
 * Whether a key or a click in the terminal is the user asking the program to copy its own selection: Ctrl+C that goes
 * to the program (on macOS too, where Cmd+C is the browser's) or a right click, the two gestures Copilot CLI names.
 * Only then, and only once, does the terminal take an OSC 52 (`ProgramCopy`), so text an agent prints (a file it shows,
 * a command's output) cannot fill the clipboard while the user types or clicks elsewhere.
 */
export function asksProgramToCopy(
  input: { kind: "key"; key: ClipboardKey } | { kind: "pointer"; button: number },
  { mac, hasSelection }: { mac: boolean; hasSelection: boolean },
): boolean {
  if (input.kind === "pointer") return input.button === 2;
  return ctrlWith(input.key, "c") && !copiesSelection(input.key, { mac, hasSelection });
}

/** One OSC 52 copy for each time the user asked for one, if it comes within `PROGRAM_COPY_MS`. */
export class ProgramCopy {
  #askedAt: number | undefined;

  asked(now: number): void {
    this.#askedAt = now;
  }

  /** Whether a copy arriving now is the answer; it uses up the request. */
  take(now: number): boolean {
    const answers = this.#askedAt !== undefined && now - this.#askedAt <= PROGRAM_COPY_MS;
    this.#askedAt = undefined;
    return answers;
  }
}
