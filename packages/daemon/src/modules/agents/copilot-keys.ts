import type { TaskState } from "@trackwall/protocol";
import { z } from "zod";
import type { KeyboardSignal } from "./task-state-tracker.ts";

/**
 * The Copilot CLI state detector from the keys a human sends to the session terminal (§4.4, ADR-17). Copilot CLI sends no
 * hook after an answer to an approval request or after an interrupted turn, so without it the session stays in
 * `Approval` until the next `postToolUse` (after approval only once the command ends), and after Esc until the session
 * ends. Only single keys count (the whole chunk of input), not the content: pasted text and arrow sequences change
 * nothing, and a recording stores only the kind of key. A digit (`choice`) selects a dialog option at once, without
 * Enter, also “No” (checked on Windows); which number is “No” depends on the dialog, so a digit counts as an answer, and
 * the interruption is then recognised from the message on the screen (`copilot-screen.ts`).
 */

/** Esc: alone a key (it stops a turn, "Esc to stop" in an approval dialog), and the first byte of every escape sequence. */
export const ESCAPE = "\u001b";

export const SessionKey = z.enum(["enter", "choice", "escape", "interrupt"]);
export type SessionKey = z.infer<typeof SessionKey>;

const KEYS: ReadonlyMap<string, SessionKey> = new Map([
  ["\r", "enter"],
  [ESCAPE, "escape"],
  ["\u0003", "interrupt"],
  ...["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit): [string, SessionKey] => [digit, "choice"]),
]);

/** States in which Copilot CLI shows a dialog with a choice, and Enter or a digit selects the answer. */
const WAITING_FOR_ANSWER: ReadonlySet<TaskState> = new Set(["Approval", "Plan"]);
const ANSWERS: ReadonlySet<SessionKey> = new Set(["enter", "choice"]);
/**
 * States that Esc and Ctrl+C interrupt: Copilot CLI then ends the turn without an `agentStop` hook. `Stale` is `Working`
 * without output, so interrupting hung work also ends the turn.
 */
const STOPPED_BY_ESCAPE: ReadonlySet<TaskState> = new Set(["Working", "Stale", "Approval", "Plan"]);

/** Whether `key` selects an answer in a dialog (Enter or a digit), unlike Esc and Ctrl+C, which stop the turn. */
export function answersDialog(key: SessionKey): boolean {
  return ANSWERS.has(key);
}

export function sessionKey(data: string): SessionKey | undefined {
  return KEYS.get(data);
}

export function stateFromKey(key: SessionKey, current: TaskState | undefined): KeyboardSignal | undefined {
  if (!current) return undefined;
  const reason = `key ${key}`;
  // Enter or a digit can also select “No, and tell Copilot…”, after which Copilot waits for text, and a digit outside
  // the option list does nothing; these are rare moments, so the confidence is only `medium`.
  if (ANSWERS.has(key))
    return WAITING_FOR_ANSWER.has(current) ? { state: "Working", source: "keyboard", confidence: "medium", reason } : undefined;
  if (STOPPED_BY_ESCAPE.has(current)) return { state: "Input", source: "keyboard", confidence: "medium", reason };
  return undefined;
}
