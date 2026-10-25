import type { StateSignal } from "./task-state-tracker.ts";

/**
 * The Copilot CLI state detector from text on the screen (§4.4, ADR-17): an interrupted turn. Copilot CLI 1.0.103 sends
 * no hook after an interruption (Esc, Ctrl+C, a refused approval), and ends it with the message “Operation cancelled by
 * user”, which in recordings from macOS and Windows arrives as continuous text. Esc and Ctrl+C are reported earlier by
 * the session key; this detector catches an interruption after Enter or a digit on “No”, which the key took as a return
 * to work. The phrase can fall on the boundary of two output chunks, so the detector keeps their tail. When the message
 * counts is decided by `CopilotSessionState` (only right after a session key).
 */

const CANCELLED = "Operation cancelled by user";

export class CopilotScreen {
  #tail = "";

  feed(text: string): StateSignal | undefined {
    const seen = this.#tail + text;
    this.#tail = seen.slice(-(CANCELLED.length - 1));
    if (!seen.includes(CANCELLED)) return undefined;
    return { state: "Input", source: "screen", confidence: "medium", reason: "screen operation cancelled" };
  }
}
