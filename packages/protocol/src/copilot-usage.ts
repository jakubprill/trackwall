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
 * The smallest `maxAiCredits` Copilot CLI takes for `--max-ai-credits` (1.0.103: "Minimum session limit is 30 AI
 * credits"); a smaller one would stop every task at its start.
 */
export const MIN_MAX_AI_CREDITS = 30;
