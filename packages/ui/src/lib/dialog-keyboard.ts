/**
 * The keyboard in an agent's approval outside its terminal (ADR-66, ADR-107): as in Copilot CLI's own dialog, the
 * options take the keyboard when the approval shows, the arrows move between them and Enter picks one, so that an
 * approval does not need the mouse.
 */

/** The option the key moves to among `count` options, from the one at `current`; `undefined` for a key that does not move. */
export function optionAfterKey(key: string, current: number, count: number): number | undefined {
  if (count === 0) return undefined;
  if (key === "ArrowDown") return Math.min(current + 1, count - 1);
  if (key === "ArrowUp") return Math.max(current - 1, 0);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return undefined;
}

/**
 * How long after an approval shows a key does not answer it: the user who just pressed Enter to send a message may
 * press it again, or keep it down, before they see the approval took the keyboard.
 */
export const KEY_ANSWER_AFTER_MS = 500;

/** Whether an answer is ignored: given with a key (not a pointer) sooner than `KEY_ANSWER_AFTER_MS` after the approval showed. */
export function keyAnswerTooSoon(byKey: boolean, shownForMs: number): boolean {
  return byKey && shownForMs < KEY_ANSWER_AFTER_MS;
}

/** The part of the focused element that tells whether the user is writing in it. */
export interface FocusedField {
  tagName: string;
  type?: unknown;
  value?: unknown;
}

/** The kinds of `<input>` the user writes text in; a checkbox has a value too, but nothing is written in it. */
const TEXT_INPUTS = new Set(["text", "search", "url", "email", ""]);

/**
 * Whether the user is in the middle of writing a message: a text field with text in it keeps the keyboard when an
 * approval shows, since the next Enter or Space meant for the text must not answer the approval.
 */
export function writingIn(focused: FocusedField | null): boolean {
  if (focused === null) return false;
  const field = focused.tagName === "TEXTAREA" || (focused.tagName === "INPUT" && TEXT_INPUTS.has(String(focused.type ?? "")));
  return field && typeof focused.value === "string" && focused.value !== "";
}
