import { z } from "zod";
import { jsonOf } from "./json.ts";

/**
 * Rekord hooka (§4.4, ADR-17): jedno wywołanie hooka z wtyczki sesji, zapisywane jako linia `hooks.jsonl`
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

const MAX_TEXT_LENGTH = 200;
const Text = z.string().transform((t) => t.slice(0, MAX_TEXT_LENGTH));

/**
 * Pola zapisywane w rekordzie; jedyna lista pól, które widzą detektory. Treść powiadomienia (`title`, `message`)
 * jest wyjątkiem: rodzaje powiadomień są udokumentowane tylko częściowo, więc bez treści nie da się poprawić
 * klasyfikacji. Może zawierać nazwę komendy, o którą agent prosi, dlatego jest przycinana, a nagranie przed
 * dodaniem do repo i tak trzeba zanonimizować (§8).
 */
const CopilotHookPayload = z.object({
  sessionId: Text.optional(),
  timestamp: z.number().optional(),
  source: Text.optional(),
  reason: Text.optional(),
  stopReason: Text.optional(),
  toolName: Text.optional(),
  notificationType: Text.optional(),
  notification_type: Text.optional(),
  type: Text.optional(),
  title: Text.optional(),
  message: Text.optional(),
});
type CopilotHookPayload = z.infer<typeof CopilotHookPayload>;
const PAYLOAD_FIELDS: Record<string, z.ZodType> = CopilotHookPayload.shape;

export const CopilotHookRecord = z.object({
  event: CopilotHookEvent,
  /** Czas odebrania przez hook, ms od epoki. */
  receivedAt: z.number(),
  payload: CopilotHookPayload,
  /** Nazwy pól payloadu, których rekord nie zapisuje (spoza listy albo innego typu). */
  omitted: z.array(z.string()),
});
export type CopilotHookRecord = z.infer<typeof CopilotHookRecord>;

const HookStdin = jsonOf(z.record(z.string(), z.unknown()));

/** Rekord hooka z surowego stdin hooka; `undefined`, gdy stdin nie jest obiektem JSON. */
export function hookRecord(event: CopilotHookEvent, stdin: string, receivedAt: number): CopilotHookRecord | undefined {
  const parsed = HookStdin.safeParse(stdin);
  if (!parsed.success) return undefined;
  const kept: Record<string, unknown> = {};
  const omitted: string[] = [];
  for (const [key, value] of Object.entries(parsed.data)) {
    const field = Object.hasOwn(PAYLOAD_FIELDS, key) ? PAYLOAD_FIELDS[key]?.safeParse(value) : undefined;
    if (field?.success) kept[key] = field.data;
    else omitted.push(key);
  }
  const payload: CopilotHookPayload = CopilotHookPayload.parse(kept);
  return { event, receivedAt, payload, omitted };
}
