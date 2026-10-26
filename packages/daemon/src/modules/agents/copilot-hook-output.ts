import { z } from "zod";
import { jsonOf } from "./json.ts";

/**
 * What the daemon answers a session hook with (ADR-85), the output types of Copilot CLI 1.0.103's SDK
 * (`copilot-sdk/types.d.ts`), checked on the real binary: `agentStop` with a block starts a new turn whose user message
 * is the reason, and `postToolUse` with additional context appends the text to the tool's result the agent reads next.
 * Any other hook, and these when nothing waits, get the empty output, which changes nothing.
 */
export type CopilotHookOutput = Record<string, never> | { decision: "block"; reason: string } | { additionalContext: string };

/** The `agentStop` payload's mark that the turn it ends was started by an earlier block. */
const AgentStopPayload = jsonOf(z.object({ stop_hook_active: z.boolean().optional() }));

/**
 * Whether the turn an `agentStop` ends was itself started by a block: then the daemon does not block again, so an agent
 * that did not read what waits is not kept in a loop of turns (Copilot CLI stops one after about 8 blocks in a row), and
 * the typed prompt takes over.
 */
export function continuesBlockedTurn(payload: string): boolean {
  const parsed = AgentStopPayload.safeParse(payload);
  return parsed.success && parsed.data.stop_hook_active === true;
}
