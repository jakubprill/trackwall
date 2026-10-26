import { z } from "zod";
import { jsonOf } from "./json.ts";

/**
 * A hook record (§4.4, ADR-17): one call of a hook from the session plugin, written as a line of `hooks.jsonl` and a
 * marker in the recording. The payload is JSON from Copilot CLI on the hook's stdin, so it is untrusted. Only the listed
 * fields needed for the state are written; of the rest only the names remain, so that recordings reveal undocumented
 * fields without storing their content (the prompt and tool arguments and results may contain code and secrets).
 */

/** The events the session plugin registers. No `preToolUse` and `permissionRequest`: their error refuses the tool. */
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
 * The fields written in a record; the only list of fields the detectors see. The notification content (`title`,
 * `message`) is the exception: notification kinds are only partly documented, so the classification cannot be improved
 * without the content. It may contain a command or a full path the agent asks about, so it is cut, and a recording has
 * to be anonymised before it is added to the repo anyway (§8).
 */
const CopilotHookPayload = z.object({
  sessionId: Text.optional(),
  timestamp: z.number().optional(),
  source: Text.optional(),
  reason: Text.optional(),
  stopReason: Text.optional(),
  /** On `agentStop`: the turn it ends was started by a hook's block (ADR-85). */
  stop_hook_active: z.boolean().optional(),
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
  /** The time the hook received it, ms since the epoch. */
  receivedAt: z.number(),
  payload: CopilotHookPayload,
  /** Names of payload fields the record does not store (not on the list or of another type). */
  omitted: z.array(z.string()),
});
export type CopilotHookRecord = z.infer<typeof CopilotHookRecord>;

const HookStdin = jsonOf(z.record(z.string(), z.unknown()));

/** A hook record from the hook's raw stdin; `undefined` when stdin is not a JSON object. */
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
