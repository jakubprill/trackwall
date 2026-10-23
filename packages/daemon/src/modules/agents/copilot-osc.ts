import type { Osc } from "./osc-parser.ts";
import type { StateSignal } from "./task-state-tracker.ts";

/**
 * Detektor stanu Copilot CLI z sekwencji terminala (§4.4, ADR-16). Copilot CLI przy domyślnym
 * `terminalProgress: true` wysyła OSC 9;4 (pasek postępu Windows Terminal / ConEmu) przez cały czas pracy
 * agenta i zdejmuje go po zakończeniu tury. Zdjęcie paska nie mówi, czy agent czeka na prompt, czy na zgodę,
 * dlatego to tylko `Input` z niską pewnością; dokładniej rozstrzygają hooki.
 */

/** OSC 9;4;<stan>;<postęp>: 0 zdjęty, 1 postęp, 2 błąd, 3 nieokreślony, 4 pauza. */
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
      return { state: "Error", source: "osc", confidence: "low", reason };
    default:
      return undefined;
  }
}

/** Tytuł okna (OSC 0 i 2): Copilot CLI wpisuje tam, nad czym agent teraz pracuje (`updateTerminalTitle`). */
export function intentFromOsc(osc: Osc): string | undefined {
  return osc.code === "0" || osc.code === "2" ? osc.data : undefined;
}
