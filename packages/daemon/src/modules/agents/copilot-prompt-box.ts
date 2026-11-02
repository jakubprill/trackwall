/** Copilot CLI waiting in its input box, read from the screen (`promptBoxOnScreen` in `@trackwall/protocol`, §4.4, ADR-69). */
import { promptBoxOnScreen } from "@trackwall/protocol";
import type { StateSignal } from "./task-state-tracker.ts";

/** The input box of a session that has no state yet: waiting for you, like the end of a turn. */
const PROMPT_BOX: StateSignal = {
  state: "Input",
  source: "screen",
  confidence: "medium",
  reason: "screen input box before the first prompt",
};

/** An idle Copilot CLI is waiting for you whether or not its box holds text. */
export function stateFromPromptBox(lines: readonly string[]): StateSignal | undefined {
  return promptBoxOnScreen(lines) === undefined ? undefined : PROMPT_BOX;
}
