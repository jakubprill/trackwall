import { isFreeSession, isSupervisor, type McpCall, type McpCallEffect, type McpCaller } from "@trackwall/protocol";
import { relativeTime } from "./format.ts";

/** Which calls the MCP calls list shows (ADR-152): all, those that write or run something, or those that failed. */
export type McpCallFilter = "all" | "changes" | "errors";

export const MCP_CALL_FILTERS: readonly { id: McpCallFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "changes", label: "Changes" },
  { id: "errors", label: "Errors" },
];

/**
 * What the list shows: the kind of call, and in Settings also one tool and one agent (`null` for any), as
 * `mcpCallChoices` names them.
 */
export interface McpCallQuery {
  show: McpCallFilter;
  tool: string | null;
  caller: string | null;
}

export function filterMcpCalls(calls: readonly McpCall[], query: McpCallQuery): McpCall[] {
  return calls.filter(
    (c) =>
      showsKind(c, query.show) &&
      (query.tool === null || c.tool === query.tool) &&
      (query.caller === null || callerLabel(c.caller) === query.caller),
  );
}

function showsKind(call: McpCall, show: McpCallFilter): boolean {
  if (show === "changes") return call.effect !== "read";
  if (show === "errors") return call.outcome.kind === "error";
  return true;
}

/**
 * The tools and agents the calls name, each once and in alphabetical order, for the filters of Settings; a chosen one
 * stays even after the audit dropped its last call, so the filter still shows why the list is empty.
 */
export function mcpCallChoices(calls: readonly McpCall[], query: McpCallQuery): { tools: string[]; callers: string[] } {
  const sorted = (values: Iterable<string>, chosen: string | null) =>
    [...new Set([...values, ...(chosen === null ? [] : [chosen])])].sort((a, b) => a.localeCompare(b));
  return {
    tools: sorted(
      calls.map((c) => c.tool),
      query.tool,
    ),
    callers: sorted(
      calls.map((c) => callerLabel(c.caller)),
      query.caller,
    ),
  };
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

/** A React key for a call: calls carry no id, and the same tool can end twice in one millisecond, so the position tells them apart. */
export function mcpCallKey(call: McpCall, index: number): string {
  return `${call.at}-${call.tool}-${index}`;
}

/** Who called, as it was at the call: the session's place survives the session. */
export function callerLabel(caller: McpCaller | null): string {
  if (caller === null) return "Agent outside Trackwall";
  if (isSupervisor(caller)) return "Supervisor";
  // `isFreeSession` is the rule; the `null` check only tells the compiler that a repo follows.
  if (isFreeSession(caller) || caller.repo === null) return "Free session";
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
