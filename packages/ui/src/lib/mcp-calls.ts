import { isSupervisor, type McpCall, type McpCallEffect, type McpCaller } from "@trackwall/protocol";
import { relativeTime } from "./format.ts";

/** Which calls the MCP calls list shows (ADR-152): all, those that write or run something, or those that failed. */
export type McpCallFilter = "all" | "changes" | "errors";

export const MCP_CALL_FILTERS: readonly { id: McpCallFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "changes", label: "Changes" },
  { id: "errors", label: "Errors" },
];

export function filterMcpCalls(calls: readonly McpCall[], filter: McpCallFilter): McpCall[] {
  if (filter === "changes") return calls.filter((c) => c.effect !== "read");
  if (filter === "errors") return calls.filter((c) => c.outcome.kind === "error");
  return [...calls];
}

/** What a tool that is not only reading does, next to its name; a read says nothing. */
const EFFECT_LABELS: Record<McpCallEffect, string | null> = {
  read: null,
  write: "writes",
  destructive: "runs or stops code",
};

/** A UUID is long; its start tells tasks and sessions apart on one screen. */
const SHORT_ID_CHARS = 8;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One call as the list shows it. */
export function mcpCallEntry(call: McpCall, now: Date) {
  return {
    tool: call.tool,
    effect: EFFECT_LABELS[call.effect],
    caller: callerLabel(call.caller),
    args: argsLabel(call.args),
    error: call.outcome.kind === "ok" ? null : `${call.outcome.code}: ${call.outcome.message}`,
    when: `${relativeTime(call.at, now)} · ${call.durationMs} ms`,
  };
}

/** Who called, as it was at the call: the session's place survives the session. */
export function callerLabel(caller: McpCaller | null): string {
  if (caller === null) return "Agent outside Trackwall";
  if (isSupervisor(caller)) return "Supervisor";
  // In the projects folder and not the supervisor: a free session (`isFreeSession`, ADR-100).
  if (caller.repo === null) return "Free session";
  return caller.task === null ? `Session in ${caller.repo}` : `Task in ${caller.repo}`;
}

/** `repo=shop task=3f2a9c1e`: the identifiers the call named, a UUID by its start; `null` when none were kept. */
function argsLabel(args: McpCall["args"]): string | null {
  const parts = Object.entries(args).map(([key, value]) => `${key}=${valueLabel(value)}`);
  return parts.length > 0 ? parts.join(" ") : null;
}

function valueLabel(value: unknown): string {
  if (Array.isArray(value)) return value.map(valueLabel).join(",");
  if (typeof value === "string") return UUID.test(value) ? value.slice(0, SHORT_ID_CHARS) : value;
  return JSON.stringify(value);
}
