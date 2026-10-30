import type { CopilotHookEvent } from "./copilot-hook-record.ts";

/**
 * What the daemon answers a session hook with (ADR-85), the output types of Copilot CLI 1.0.103's SDK
 * (`copilot-sdk/types.d.ts`), checked on the real binary: `agentStop` with a block starts a new turn whose user message
 * is the reason, and `postToolUse` with additional context appends the text to the tool's result the agent reads next.
 * `userPromptSubmitted` with additional context gives the supervisor its situation (ADR-148, `situationOutput`). Any
 * other hook, and these when nothing waits, get the empty output, which changes nothing.
 */
export type CopilotHookOutput = Record<string, never> | { decision: "block"; reason: string } | { additionalContext: string };

/** What a session knows when a hook comes, the hook's record already read. */
export interface HookOutputInput {
  event: CopilotHookEvent;
  /** On `agentStop`: the turn it ends was itself started by a block (`stop_hook_active`). */
  blockedTurn: boolean;
  /** The prompt asked for (`askToRead`) and still unread, or `undefined`. */
  prompt: string | undefined;
  /** The prompt last given with a tool's result in this turn. */
  contextGiven: string | undefined;
  /** The input box may hold the user's unsent text. */
  userDraft: boolean;
}

/**
 * The hook output for what waits: with a tool's result once per turn and prompt, so the agent reads it before it ends
 * the turn, and at the end of a turn as a block, which the agent gets even if it ignored the context. Not into the
 * user's draft (the block would start a turn under it), and not at the end of a turn a block started, so an agent that
 * does not read what waits is not kept in a loop of turns (Copilot CLI stops one after about 8 blocks in a row).
 */
export function hookOutputFor(input: HookOutputInput): CopilotHookOutput {
  const { event, prompt } = input;
  if (prompt === undefined) return {};
  if (event === "postToolUse") return prompt === input.contextGiven ? {} : { additionalContext: prompt };
  if (event === "agentStop" && !input.blockedTurn && !input.userDraft) return { decision: "block", reason: prompt };
  return {};
}

/**
 * A prompt the agent got, the user's or the daemon's, with the situation (ADR-148) as the `userPromptSubmitted` hook's
 * context, which Copilot CLI adds after the prompt as a system reminder, in a terminal and over ACP alike; nothing for
 * a session without one.
 */
export function situationOutput(situation: string | undefined): CopilotHookOutput {
  return situation === undefined ? {} : { additionalContext: situation };
}
