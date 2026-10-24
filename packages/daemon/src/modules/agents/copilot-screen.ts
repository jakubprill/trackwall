import type { StateSignal } from "./task-state-tracker.ts";

/**
 * Detektor stanu Copilot CLI z tekstu na ekranie (§4.4, ADR-17): przerwana tura. Copilot CLI 1.0.103 nie wysyła
 * hooka po przerwaniu (Esc, Ctrl+C, odmowa zgody), a kończy je komunikatem „Operation cancelled by user”, który
 * w nagraniach z macOS i z Windowsa przychodzi jako ciągły tekst. Klawisz sesji zwykle zgłasza to wcześniej; ten
 * detektor łapie przerwanie, którego klawisz nie rozpoznał (np. wybór opcji cyfrą). Fraza może trafić na granicę
 * dwóch kawałków wyjścia, więc detektor trzyma ich końcówkę. Kiedy komunikat się liczy, rozstrzyga
 * `CopilotSessionState` (tylko tuż po klawiszu sesji).
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
