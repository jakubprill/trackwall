import type { TaskState } from "@trackwall/protocol";
import { z } from "zod";
import type { KeyboardSignal } from "./task-state-tracker.ts";

/**
 * Detektor stanu Copilot CLI z klawiszy, które człowiek wysyła do terminala sesji (§4.4, ADR-17). Copilot CLI
 * nie wysyła hooka po odpowiedzi na prośbę o zgodę ani po przerwaniu tury, więc bez tego sesja zostaje
 * w `Approval` do następnego `postToolUse` (po zgodzie dopiero po końcu komendy), a po Esc do końca sesji.
 * Liczą się tylko pojedyncze klawisze (cały kawałek wejścia), nie treść: wklejony tekst i sekwencje strzałek
 * niczego nie zmieniają, a nagranie zapisuje sam rodzaj klawisza.
 */

export const SessionKey = z.enum(["enter", "escape", "interrupt"]);
export type SessionKey = z.infer<typeof SessionKey>;

const KEYS: ReadonlyMap<string, SessionKey> = new Map([
  ["\r", "enter"],
  ["\u001b", "escape"],
  ["\u0003", "interrupt"],
]);

/** Stany, w których Copilot CLI pokazuje okno z wyborem, a Enter zatwierdza wybraną odpowiedź. */
const ANSWERED_BY_ENTER: ReadonlySet<TaskState> = new Set(["Approval", "Plan"]);
/**
 * Stany, które Esc i Ctrl+C przerywają: Copilot CLI kończy wtedy turę bez hooka `agentStop`. `Stale` to `Working`
 * bez wyjścia, więc przerwanie zawieszonej pracy też kończy turę.
 */
const STOPPED_BY_ESCAPE: ReadonlySet<TaskState> = new Set(["Working", "Stale", "Approval", "Plan"]);

export function sessionKey(data: string): SessionKey | undefined {
  return KEYS.get(data);
}

export function stateFromKey(key: SessionKey, current: TaskState | undefined): KeyboardSignal | undefined {
  if (!current) return undefined;
  const reason = `key ${key}`;
  // Enter może też wybrać „No, and tell Copilot…”, po którym Copilot czeka na tekst; to krótka chwila,
  // w której i tak piszesz, więc pewność tylko `medium`.
  if (key === "enter" && ANSWERED_BY_ENTER.has(current)) return { state: "Working", source: "keyboard", confidence: "medium", reason };
  if (key !== "enter" && STOPPED_BY_ESCAPE.has(current)) return { state: "Input", source: "keyboard", confidence: "medium", reason };
  return undefined;
}
