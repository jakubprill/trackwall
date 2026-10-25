import type { TaskState, TaskStateChange } from "@trackwall/protocol";
import type { CopilotHookRecord } from "./copilot-hook-record.ts";
import type { StateSignal } from "./task-state-tracker.ts";

/**
 * The Copilot CLI state detector from hook records (§4.4, ADR-17), the most reliable source. Certain from the Copilot CLI
 * documentation: event names, `sessionEnd.reason`, `agentStop.stopReason`. Uncertain: the fields and kinds of
 * `notification`, which the documentation does not list. That is why a notification is classified by a known kind, and
 * without a kind by words of its content (confidence `low`).
 */

/** The hooks after which Copilot CLI's input box waits for a new message: the start of the session and the end of a turn. */
const AT_PROMPT_EVENTS = ["sessionStart", "agentStop"] as const;

/**
 * The session waits in its input box, by a hook rather than a question dialog (`elicitation_dialog`), a guess from
 * the screen or an Esc: only then can the daemon type a prompt for the user (ADR-62).
 */
export function atPromptBox(change: Pick<TaskStateChange, "state" | "reason">): boolean {
  return change.state === "Input" && AT_PROMPT_EVENTS.some((event) => change.reason === hookReason(event));
}

function hookReason(event: CopilotHookRecord["event"]): string {
  return `hook ${event}`;
}

export function stateFromHook(record: CopilotHookRecord): StateSignal | undefined {
  const reason = hookReason(record.event);
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
  const end = payload.reason ?? "unknown";
  const failed = end === "error" || end === "timeout";
  return { state: failed ? "Error" : "Done", source: "hook", confidence: "high", reason: `${reason} ${end}`, endsSession: true };
}

/**
 * Notification kinds of the main agent found with Copilot CLI 1.0.103. `permission_prompt` (types of
 * `@github/copilot-sdk`) came in a real session on macOS with an approval request, so it has confidence `high`;
 * `elicitation_dialog` is known only from Copilot CLI's texts, so `medium` until a recording confirms it. Other kinds
 * (e.g. `agent_idle`, `agent_completed` and `shell_completed` are about background agents and commands) do not change
 * the state, even if the content sounds like an approval request. No kind for a plan was found; `Plan` comes only from the content.
 */
const KIND_STATES: Record<string, Pick<StateSignal, "state" | "confidence">> = {
  permission_prompt: { state: "Approval", confidence: "high" },
  elicitation_dialog: { state: "Input", confidence: "medium" },
};

/** Content without a kind: only whole words, so that “explanation” is not a plan and “task” not a question. */
const TEXT_RULES: { pattern: RegExp; state: TaskState }[] = [
  { pattern: /\b(permission|approve|allow)\b/i, state: "Approval" },
  { pattern: /\bplan\b/i, state: "Plan" },
  { pattern: /\b(idle|question|waiting for (your )?input)\b/i, state: "Input" },
];

function notification(payload: CopilotHookRecord["payload"], reason: string): StateSignal | undefined {
  const kind = payload.notificationType ?? payload.notification_type ?? payload.type;
  if (kind !== undefined) {
    const known = Object.hasOwn(KIND_STATES, kind) ? KIND_STATES[kind] : undefined;
    return known && { ...known, source: "hook", reason: `${reason} ${kind}` };
  }
  const text = [payload.title, payload.message].filter(Boolean).join(" ");
  const state = TEXT_RULES.find((r) => r.pattern.test(text))?.state;
  return state && { state, source: "hook", confidence: "low", reason: `${reason} (text)` };
}
