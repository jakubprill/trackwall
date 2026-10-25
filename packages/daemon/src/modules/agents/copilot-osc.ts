import type { Osc } from "./osc-parser.ts";
import type { StateSignal } from "./task-state-tracker.ts";

/**
 * The Copilot CLI state detector from terminal sequences (§4.4, ADR-17). With the default `terminalProgress: true`
 * Copilot CLI sends OSC 9;4 (the Windows Terminal / ConEmu progress bar) the whole time the agent works and removes it
 * after the turn ends. Removing the bar does not say whether the agent waits for a prompt or for approval, so it is only
 * `Input` with low confidence; hooks decide more precisely.
 */

/** OSC 9;4;<state>;<progress>: 0 removed, 1 progress, 2 error, 3 indeterminate, 4 paused. */
const PROGRESS_PREFIX = "4;";

export function stateFromOsc(osc: Osc): StateSignal | undefined {
  if (osc.code !== "9" || !osc.data.startsWith(PROGRESS_PREFIX)) return undefined;
  const progress = osc.data.slice(PROGRESS_PREFIX.length).split(";")[0];
  const reason = `osc 9;4;${progress}`;
  switch (progress) {
    case "1":
    case "3":
      return { state: "Working", source: "osc", confidence: "high", reason };
    case "0":
      return { state: "Input", source: "osc", confidence: "low", reason };
    case "2":
      // The bar's error state; Copilot CLI does not document when it sets it, so only low confidence.
      return { state: "Error", source: "osc", confidence: "low", reason };
    default:
      return undefined;
  }
}

/** The window title (OSC 0 and 2): Copilot CLI writes there what the agent is working on now (`updateTerminalTitle`). */
export function windowTitleFromOsc(osc: Osc): string | undefined {
  return osc.code === "0" || osc.code === "2" ? osc.data : undefined;
}
