import { z } from "zod";
import { jsonOf } from "./json.ts";

/**
 * Rekord hooka (§4.4, ADR-16): jedno wywołanie hooka z wtyczki sesji, zapisywane jako linia `hooks.jsonl`
 * i znacznik w nagraniu. Payload to JSON od Copilot CLI na stdin hooka, więc jest niezaufany. Zapisywane są
 * tylko pola z listy, potrzebne do stanu; o reszcie zostają same nazwy, żeby z nagrań dało się poznać
 * nieudokumentowane pola bez zapisywania ich treści (prompt, argumenty i wyniki narzędzi mogą zawierać kod
 * i sekrety).
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

const Scalar = z.union([z.string(), z.number(), z.boolean()]);

export const CopilotHookRecord = z.object({
  event: CopilotHookEvent,
  /** Czas odebrania przez hook, ms od epoki. */
  receivedAt: z.number(),
  payload: z.record(z.string(), Scalar),
  /** Nazwy pól payloadu, których rekord nie zapisuje. */
  omitted: z.array(z.string()),
});
export type CopilotHookRecord = z.infer<typeof CopilotHookRecord>;

/**
 * Pola zapisywane w rekordzie. Treść powiadomienia (`title`, `message`) jest wyjątkiem: rodzaje powiadomień
 * nie są udokumentowane, więc bez treści nie da się poprawić klasyfikacji. Może zawierać nazwę komendy, o którą
 * agent prosi, dlatego jest przycinana, a nagranie przed dodaniem do repo i tak trzeba zanonimizować (§8).
 */
const KEPT_FIELDS = new Set([
  "sessionId",
  "timestamp",
  "source",
  "reason",
  "stopReason",
  "toolName",
  "notificationType",
  "notification_type",
  "type",
  "title",
  "message",
]);
const MAX_TEXT_LENGTH = 200;

const HookStdin = jsonOf(z.record(z.string(), z.unknown()));

/** Rekord hooka z surowego stdin hooka; `undefined`, gdy stdin nie jest obiektem JSON. */
export function hookRecord(event: CopilotHookEvent, stdin: string, receivedAt: number): CopilotHookRecord | undefined {
  const parsed = HookStdin.safeParse(stdin);
  if (!parsed.success) return undefined;
  const payload: Record<string, z.infer<typeof Scalar>> = {};
  const omitted: string[] = [];
  for (const [key, value] of Object.entries(parsed.data)) {
    const scalar = Scalar.safeParse(value);
    if (!KEPT_FIELDS.has(key) || !scalar.success) omitted.push(key);
    else payload[key] = typeof scalar.data === "string" ? scalar.data.slice(0, MAX_TEXT_LENGTH) : scalar.data;
  }
  return { event, receivedAt, payload, omitted };
}
