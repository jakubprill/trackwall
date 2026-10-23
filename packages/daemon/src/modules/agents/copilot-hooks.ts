import type { TaskState } from "@trackwall/protocol";
import type { CopilotHookRecord } from "./copilot-hook-record.ts";
import type { StateSignal } from "./task-state-tracker.ts";

/**
 * Detektor stanu Copilot CLI z rekordów hooków (§4.4, ADR-16), najpewniejsze źródło. Pewne z dokumentacji
 * Copilot CLI: nazwy zdarzeń, `sessionEnd.reason`, `agentStop.stopReason`. Niepewne: pola i rodzaje
 * `notification`, których dokumentacja nie wylicza (`permission_prompt` w typach `@github/copilot-sdk`, `elicitation_dialog` w tekstach Copilot CLI 1.0.103). Dlatego
 * powiadomienie jest klasyfikowane po znanym rodzaju (pewność `medium`), a bez rodzaju po słowach treści
 * (pewność `low`).
 */

export function stateFromHook(record: CopilotHookRecord): StateSignal | undefined {
  const reason = `hook ${record.event}`;
  switch (record.event) {
    case "sessionStart":
      return { state: "Input", source: "hook", confidence: "medium", reason };
    case "userPromptSubmitted":
    case "postToolUse":
      return { state: "Working", source: "hook", confidence: "high", reason };
    case "agentStop":
      return { state: "Input", source: "hook", confidence: "high", reason };
    case "errorOccurred":
      return { state: "Error", source: "hook", confidence: "medium", reason };
    case "sessionEnd":
      return sessionEnd(record.payload, reason);
    case "notification":
      return notification(record.payload, reason);
  }
}

function sessionEnd(payload: CopilotHookRecord["payload"], reason: string): StateSignal {
  const end = payload.reason ?? "nieznany";
  const failed = end === "error" || end === "timeout";
  return { state: failed ? "Error" : "Done", source: "hook", confidence: "high", reason: `${reason} ${end}`, endsSession: true };
}

/**
 * Rodzaje powiadomień głównego agenta znalezione przy Copilot CLI 1.0.103. Inne rodzaje (np. `agent_idle`,
 * `agent_completed` i `shell_completed` dotyczą agentów i komend w tle) nie zmieniają stanu, nawet jeśli treść
 * brzmi jak prośba o zgodę. Rodzaju dla planu nie znaleziono; `Plan` daje tylko treść.
 */
const KIND_STATES: Record<string, TaskState> = {
  permission_prompt: "Approval",
  elicitation_dialog: "Input",
};

/** Treść bez rodzaju: tylko całe słowa, żeby „explanation” nie było planem, a „task” pytaniem. */
const TEXT_RULES: { pattern: RegExp; state: TaskState }[] = [
  { pattern: /\b(permission|approve|allow)\b/i, state: "Approval" },
  { pattern: /\bplan\b/i, state: "Plan" },
  { pattern: /\b(idle|question|waiting for (your )?input)\b/i, state: "Input" },
];

function notification(payload: CopilotHookRecord["payload"], reason: string): StateSignal | undefined {
  const kind = payload.notificationType ?? payload.notification_type ?? payload.type;
  if (kind !== undefined) {
    const state = Object.hasOwn(KIND_STATES, kind) ? KIND_STATES[kind] : undefined;
    return state && { state, source: "hook", confidence: "medium", reason: `${reason} ${kind}` };
  }
  const text = [payload.title, payload.message].filter(Boolean).join(" ");
  const state = TEXT_RULES.find((r) => r.pattern.test(text))?.state;
  return state && { state, source: "hook", confidence: "low", reason: `${reason} (treść)` };
}
