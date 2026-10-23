import type { TaskState } from "@trackwall/protocol";
import { z } from "zod";
import type { StateSignal } from "./task-state-tracker.ts";

/**
 * Detektor stanu Copilot CLI z hooków (§4.4, ADR-16), najpewniejsze źródło. Hooki rejestruje wtyczka sesji
 * (`copilot-plugin.ts`); każde wywołanie trafia jako rekord hooka do pliku `hooks.jsonl` sesji, a stąd do
 * trackera. Payload to JSON od Copilot CLI na stdin hooka, więc jest niezaufany i parsowany schematem.
 *
 * Pewne z dokumentacji Copilot CLI: nazwy zdarzeń, `sessionEnd.reason`, `agentStop.stopReason`. Niepewne:
 * pola i wartości `notification` (dokumentacja ich nie wylicza), dlatego klasyfikacja po słowach z niską
 * pewnością, a surowy payload zostaje w nagraniu do poprawienia reguł.
 */

/** Zdarzenia, które rejestruje wtyczka sesji. Bez `preToolUse` i `permissionRequest`: ich błąd odmawia narzędzia. */
export const COPILOT_HOOK_EVENTS = [
  "sessionStart",
  "userPromptSubmitted",
  "postToolUse",
  "notification",
  "agentStop",
  "errorOccurred",
  "sessionEnd",
] as const;
export const CopilotHookEvent = z.enum(COPILOT_HOOK_EVENTS);
export type CopilotHookEvent = z.infer<typeof CopilotHookEvent>;

/** Jedna linia `hooks.jsonl`: zdarzenie, czas odebrania (ms od epoki) i payload bez pól z treścią sesji. */
export const CopilotHookRecord = z.object({
  event: CopilotHookEvent,
  at: z.number(),
  payload: z.record(z.string(), z.unknown()),
});
export type CopilotHookRecord = z.infer<typeof CopilotHookRecord>;

/**
 * Pola payloadu z treścią sesji (prompt, argumenty i wynik narzędzi, ścieżka transkryptu). Nie są potrzebne do
 * stanu, a mogą zawierać kod i sekrety, więc rekord ich nie zapisuje.
 */
const CONTENT_FIELDS = new Set(["prompt", "initialPrompt", "transformedPrompt", "toolArgs", "toolResult", "transcriptPath"]);
const MAX_FIELD_LENGTH = 500;

/** Rekord hooka z surowego stdin hooka; `undefined`, gdy stdin nie jest obiektem JSON. */
export function hookRecord(event: CopilotHookEvent, stdin: string, at: number): CopilotHookRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdin);
  } catch {
    return undefined;
  }
  const payload = z.record(z.string(), z.unknown()).safeParse(parsed);
  if (!payload.success) return undefined;
  const kept = Object.entries(payload.data)
    .filter(([key]) => !CONTENT_FIELDS.has(key))
    .map(([key, value]) => [key, typeof value === "string" ? value.slice(0, MAX_FIELD_LENGTH) : value]);
  return { event, at, payload: Object.fromEntries(kept) };
}

const SessionEnd = z.looseObject({ reason: z.string().optional() });
const Notification = z.looseObject({
  notificationType: z.string().optional(),
  notification_type: z.string().optional(),
  type: z.string().optional(),
  title: z.string().optional(),
  message: z.string().optional(),
});

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

function sessionEnd(payload: unknown, reason: string): StateSignal {
  const end = SessionEnd.safeParse(payload).data?.reason ?? "nieznany";
  const failed = end === "error" || end === "timeout";
  return { state: failed ? "Error" : "Done", source: "hook", confidence: "high", reason: `${reason} ${end}` };
}

/**
 * Kolejność ma znaczenie: pierwsza pasująca reguła wygrywa. Zakończenie komendy w tle (`shell`) nie mówi nic
 * o tym, czy agent czeka, więc jest pomijane przed regułą na „complete”; „permission” w treści o planie to wciąż
 * prośba o zgodę.
 */
const NOTIFICATION_RULES: { pattern: RegExp; state: TaskState | undefined }[] = [
  { pattern: /shell/i, state: undefined },
  { pattern: /permission|approv/i, state: "Approval" },
  { pattern: /plan/i, state: "Plan" },
  { pattern: /elicit|question|ask|input|idle|complete|finish/i, state: "Input" },
];

function notification(payload: unknown, reason: string): StateSignal | undefined {
  const n = Notification.safeParse(payload).data;
  if (!n) return undefined;
  const kind = n.notificationType ?? n.notification_type ?? n.type ?? "";
  const text = [kind, n.title, n.message].filter(Boolean).join(" ");
  const state = NOTIFICATION_RULES.find((r) => r.pattern.test(text))?.state;
  return state && { state, source: "hook", confidence: "medium", reason: `${reason} ${kind}`.trim() };
}
