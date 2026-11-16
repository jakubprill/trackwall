import { z } from "zod";
import { jsonOf } from "./json.ts";

/**
 * The background agents of a conversation (ADR-254), from the events Copilot CLI appends to its event log: the `task`
 * tool's `subagent.started` with `executionMode: "background"`, and `subagent.completed` or `subagent.failed` of the same
 * tool call, which Copilot CLI writes also when the user stops its agents with Ctrl+C. While one runs, an `agentStop`
 * of the main agent does not end its work: Copilot CLI shows "Waiting for background agents" and starts the main
 * agent's next turn itself once they finish. Like the usage receipt, the format is Copilot CLI's own and undocumented;
 * a contract test pins it.
 */

/** A line without one of these texts is not parsed at all, since tool results can make lines long. */
const STARTED = "subagent.started";
const ENDED = ["subagent.completed", "subagent.failed"] as const;

const StartedLine = jsonOf(
  z.object({ type: z.literal(STARTED), data: z.object({ toolCallId: z.string().min(1), executionMode: z.literal("background") }) }),
);
const EndedLine = jsonOf(z.object({ type: z.enum(ENDED), data: z.object({ toolCallId: z.string().min(1) }) }));

/** What a line of the event log says about a background agent; `undefined` for any other line. */
export type BackgroundAgentEvent = { started: string } | { ended: string };

export function backgroundAgentEventOf(line: string): BackgroundAgentEvent | undefined {
  if (line.includes(STARTED)) {
    const started = StartedLine.safeParse(line);
    return started.success ? { started: started.data.data.toolCallId } : undefined;
  }
  if (!ENDED.some((type) => line.includes(type))) return undefined;
  const ended = EndedLine.safeParse(line);
  return ended.success ? { ended: ended.data.data.toolCallId } : undefined;
}

/** The tool calls of the background agents still running after `event`. */
export function runningAfter(running: readonly string[], event: BackgroundAgentEvent): readonly string[] {
  if ("started" in event) return running.includes(event.started) ? running : [...running, event.started];
  return running.filter((id) => id !== event.ended);
}
