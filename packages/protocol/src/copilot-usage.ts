import { z } from "zod";

/**
 * What a session's Copilot CLI conversation has used so far (ADR-190), summed from the receipt Copilot CLI writes to the
 * conversation's event log after every model call. It covers the whole conversation, so a session that goes on with a
 * conversation (`--resume`, a restart, a resumed task) shows what it used since its first prompt.
 */
export const CopilotUsage = z.object({
  /** Model calls, the session's own and its sub-agents'. */
  modelCalls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /**
   * AI credits (1 credit = $0.01) the calls cost, as Copilot CLI's `/usage` counts them; `null` when no call reported
   * them: a model of your own provider (BYOK), or a plan still billed by premium requests.
   */
  aiCredits: z.number().nonnegative().nullable(),
  /** Some calls reported AI credits and some did not, so `aiCredits` is a lower bound. */
  aiCreditsPartial: z.boolean(),
  /** Premium requests of the legacy billing (the model's multiplier for each call the user started). */
  premiumRequests: z.number().nonnegative(),
});
export type CopilotUsage = z.infer<typeof CopilotUsage>;

/**
 * The sum of several conversations' usage; `null` when there are none. AI credits sum over the conversations that
 * reported them, and the sum is partial when one did not.
 */
export function sumUsage(usages: readonly CopilotUsage[]): CopilotUsage | null {
  if (usages.length === 0) return null;
  const withCredits = usages.filter((u) => u.aiCredits !== null);
  const total = (of: (usage: CopilotUsage) => number) => usages.reduce((sum, usage) => sum + of(usage), 0);
  return {
    modelCalls: total((u) => u.modelCalls),
    inputTokens: total((u) => u.inputTokens),
    outputTokens: total((u) => u.outputTokens),
    aiCredits: withCredits.length === 0 ? null : withCredits.reduce((sum, u) => sum + (u.aiCredits ?? 0), 0),
    aiCreditsPartial: usages.some((u) => u.aiCreditsPartial) || (withCredits.length > 0 && withCredits.length < usages.length),
    premiumRequests: total((u) => u.premiumRequests),
  };
}

/**
 * A conversation's own model calls on one model (ADR-228), as their receipts name it; a sub-agent's calls, which may
 * run on a model of their own, are not counted.
 */
export const ModelCalls = z.object({
  model: z.string(),
  modelCalls: z.number().int().positive(),
});
export type ModelCalls = z.infer<typeof ModelCalls>;

/**
 * The smallest `maxAiCredits` Copilot CLI takes for `--max-ai-credits` (1.0.103: "Minimum session limit is 30 AI
 * credits"); a smaller one would stop every task at its start.
 */
export const MIN_MAX_AI_CREDITS = 30;
