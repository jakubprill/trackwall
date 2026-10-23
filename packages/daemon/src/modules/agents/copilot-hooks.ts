import type { TaskState } from "@trackwall/protocol";
import { z } from "zod";
import type { CopilotHookRecord } from "./copilot-hook-record.ts";
import type { StateSignal } from "./task-state-tracker.ts";

/**
 * Detektor stanu Copilot CLI z rekordów hooków (§4.4, ADR-16), najpewniejsze źródło. Pewne z dokumentacji
 * Copilot CLI: nazwy zdarzeń, `sessionEnd.reason`, `agentStop.stopReason`. Niepewne: pola i rodzaje
 * `notification`, których dokumentacja nie wylicza. Dlatego powiadomienie jest klasyfikowane najpierw po rodzaju
 * (pewność `medium`), a bez rodzaju po słowach treści (pewność `low`).
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

const SessionEnd = z.looseObject({ reason: z.string().optional() });

function sessionEnd(payload: unknown, reason: string): StateSignal {
  const end = SessionEnd.safeParse(payload).data?.reason ?? "nieznany";
  const failed = end === "error" || end === "timeout";
  return { state: failed ? "Error" : "Done", source: "hook", confidence: "high", reason: `${reason} ${end}`, endsSession: true };
}

const Notification = z.looseObject({
  notificationType: z.string().optional(),
  notification_type: z.string().optional(),
  type: z.string().optional(),
  title: z.string().optional(),
  message: z.string().optional(),
});

/**
 * Rodzaj powiadomienia, np. `permission_prompt`. Rodzaj, który nie pasuje (np. zakończenie komendy w tle),
 * nie zmienia stanu, nawet jeśli treść brzmi jak prośba o zgodę.
 */
const KIND_RULES: { pattern: RegExp; state: TaskState }[] = [
  { pattern: /permission|approval/i, state: "Approval" },
  { pattern: /plan/i, state: "Plan" },
  { pattern: /elicitation|question|input|idle|agent_(complete|finish)/i, state: "Input" },
];

/** Treść bez rodzaju: tylko całe słowa, żeby „explanation” nie było planem, a „task” pytaniem. */
const TEXT_RULES: { pattern: RegExp; state: TaskState }[] = [
  { pattern: /\b(permission|approve|allow)\b/i, state: "Approval" },
  { pattern: /\bplan\b/i, state: "Plan" },
  { pattern: /\b(idle|question|waiting for (your )?input)\b/i, state: "Input" },
];

function notification(payload: unknown, reason: string): StateSignal | undefined {
  const n = Notification.safeParse(payload).data;
  if (!n) return undefined;
  const kind = n.notificationType ?? n.notification_type ?? n.type;
  if (kind !== undefined) {
    const state = KIND_RULES.find((r) => r.pattern.test(kind))?.state;
    return state && { state, source: "hook", confidence: "medium", reason: `${reason} ${kind}` };
  }
  const text = [n.title, n.message].filter(Boolean).join(" ");
  const state = TEXT_RULES.find((r) => r.pattern.test(text))?.state;
  return state && { state, source: "hook", confidence: "low", reason: `${reason} (treść)` };
}
