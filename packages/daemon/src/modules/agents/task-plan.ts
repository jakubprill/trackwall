import { mcpTools } from "@trackwall/protocol";

/**
 * "Plan first" for a task (ADR-229): its agent starts in Copilot CLI's Plan mode, which refuses to change files, and the
 * user approves the plan in Trackwall before the agent implements it. Over ACP Copilot CLI's agent does not leave Plan
 * mode itself (it never calls its `exit_plan_mode` there, it ends its turn), so the daemon tells it what the plan is for
 * with the first message and switches it to Agent mode with the approval, whose prompt it gets as the user's message.
 */

/** The first message of a task that plans first: its prompt, then what the agent does with it in Plan mode. */
export function planFirstMessage(prompt: string): string {
  return [
    prompt,
    "",
    "---",
    `Plan first: you are in Plan mode, and the user approves your plan in Trackwall before you change anything. Read what you need, then answer with the plan: what you will change and where, how you will test it, and any question you need answered first. Do not change files, and do not call ${mcpTools.verifyTask.name} or ${mcpTools.reportResult.name} yet. End your turn with the plan; the user may ask you to change it before approving it.`,
  ].join("\n");
}

/** The user's message with the approval of the plan, sent once the agent is in Agent mode. */
export const PLAN_APPROVED_MESSAGE =
  "I approved your plan, and you are in Agent mode now. Implement it as the task asks, test it, and report your result.";
