import type { CopilotUsage } from "@trackwall/protocol";
import { z } from "zod";

/**
 * The receipt Copilot CLI appends to a conversation's event log after every model call, `session.usage_record`
 * (ADR-190), and how receipts add up: one place for the rule, for a session's usage in `agents` and the weekly usage
 * report in `usage-report` (ADR-199). The format is Copilot CLI's own and undocumented; a contract test pins the fields
 * read here, and anything else in a line is ignored.
 */

/** The receipt's type; a line without this text is not parsed at all, since tool results can make lines long. */
const USAGE_RECORD = "session.usage_record";

const NANO_AIU_PER_AI_CREDIT = 1e9;

/** The initiator of the conversation's own further calls in a turn, after a tool result: not a new premium request. */
const CONVERSATION_FOLLOW_UP = "agent";

const UsageRecord = z.object({
  type: z.literal(USAGE_RECORD),
  /** When Copilot CLI wrote it, ISO 8601. */
  timestamp: z.string().optional(),
  data: z.object({
    usage: z.object({
      /** The model the call ran on, as Copilot CLI names it (seen in 1.0.107; ADR-225). */
      model: z.string().min(1).optional(),
      inputTokens: z.number().int().nonnegative().default(0),
      outputTokens: z.number().int().nonnegative().default(0),
      /** The model multiplier of the call (premium requests of the legacy billing). */
      cost: z.number().nonnegative().default(0),
      /**
       * What started the call: absent or `user` for the call that opens the user's turn, `agent` for the conversation's
       * further calls in the turn (after a tool result; seen in 1.0.107), `sub-agent` and others for the rest.
       */
      initiator: z.string().optional(),
      aiCreditsStatus: z.enum(["complete", "partial", "unavailable"]).optional(),
      copilotUsage: z.object({ totalNanoAiu: z.number().nonnegative().optional() }).optional(),
      /** The tokens of the tool definitions the call sent with its prompt, part of `inputTokens` (seen in 1.0.103). */
      toolTokenCount: z.number().int().nonnegative().default(0),
      /** Copilot CLI's own identity of the receipt, the same when a resumed conversation writes it again. */
      accounting: z.object({ sourceSessionId: z.string(), sequence: z.number().int() }).optional(),
    }),
  }),
});

/** One model call as its receipt reports it. */
export interface UsageReceipt {
  /** Copilot CLI's identity of the receipt, to count a receipt written again once; absent in older receipts. */
  key: string | undefined;
  /** When it was written; absent when the line has no time. */
  at: string | undefined;
  inputTokens: number;
  outputTokens: number;
  toolDefinitionTokens: number;
  /** The call's cost in nano AI units; absent when the call reported none. */
  nanoAiu: number | undefined;
  /** The call reported no AI credits or only some of them. */
  creditsMissing: boolean;
  /** Premium requests: the model multiplier of a call the user started, nothing for the turn's further calls or a sub-agent's. */
  premiumRequests: number;
  /**
   * The model of a call the conversation made itself, the user's turn or its further calls, not a sub-agent's, which may
   * run on a model of its own.
   */
  ownModel: string | undefined;
}

/** A receipt from an event log's line; `undefined` for any other line. */
export function usageReceipt(line: string): UsageReceipt | undefined {
  if (!line.includes(USAGE_RECORD)) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return undefined;
  }
  const parsed = UsageRecord.safeParse(json);
  if (!parsed.success) return undefined;
  const usage = parsed.data.data.usage;
  const nanoAiu = usage.aiCreditsStatus === "unavailable" ? undefined : usage.copilotUsage?.totalNanoAiu;
  const userTurn = usage.initiator === undefined || usage.initiator === "user";
  const own = userTurn || usage.initiator === CONVERSATION_FOLLOW_UP;
  return {
    key: usage.accounting && `${usage.accounting.sourceSessionId}:${usage.accounting.sequence}`,
    at: parsed.data.timestamp,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    toolDefinitionTokens: usage.toolTokenCount,
    nanoAiu,
    creditsMissing: nanoAiu === undefined || usage.aiCreditsStatus === "partial",
    premiumRequests: userTurn ? usage.cost : 0,
    ownModel: own ? usage.model : undefined,
  };
}

/**
 * Whether this is the first time `seen` meets the receipt, which it then remembers: a resumed conversation writes its
 * receipts again under the same identity, and they count once. A receipt without an identity always counts.
 */
export function firstSighting(seen: Set<string>, receipt: UsageReceipt): boolean {
  if (receipt.key === undefined) return true;
  if (seen.has(receipt.key)) return false;
  seen.add(receipt.key);
  return true;
}

/** Running sums of receipts. */
export interface UsageTotals {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  toolDefinitionTokens: number;
  nanoAiu: number;
  callsWithCredits: number;
  callsWithoutCredits: number;
  premiumRequests: number;
}

export const NO_USAGE: UsageTotals = {
  modelCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  toolDefinitionTokens: 0,
  nanoAiu: 0,
  callsWithCredits: 0,
  callsWithoutCredits: 0,
  premiumRequests: 0,
};

export function addReceipt(totals: UsageTotals, receipt: UsageReceipt): UsageTotals {
  return {
    modelCalls: totals.modelCalls + 1,
    inputTokens: totals.inputTokens + receipt.inputTokens,
    outputTokens: totals.outputTokens + receipt.outputTokens,
    toolDefinitionTokens: totals.toolDefinitionTokens + receipt.toolDefinitionTokens,
    nanoAiu: totals.nanoAiu + (receipt.nanoAiu ?? 0),
    callsWithCredits: totals.callsWithCredits + (receipt.nanoAiu === undefined ? 0 : 1),
    callsWithoutCredits: totals.callsWithoutCredits + (receipt.creditsMissing ? 1 : 0),
    premiumRequests: totals.premiumRequests + receipt.premiumRequests,
  };
}

/** The sums of two sets of receipts, e.g. two conversations. */
export function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    modelCalls: a.modelCalls + b.modelCalls,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    toolDefinitionTokens: a.toolDefinitionTokens + b.toolDefinitionTokens,
    nanoAiu: a.nanoAiu + b.nanoAiu,
    callsWithCredits: a.callsWithCredits + b.callsWithCredits,
    callsWithoutCredits: a.callsWithoutCredits + b.callsWithoutCredits,
    premiumRequests: a.premiumRequests + b.premiumRequests,
  };
}

/** The sums as the UI shows them; `null` before the first model call. */
export function usageOf(totals: UsageTotals): CopilotUsage | null {
  if (totals.modelCalls === 0) return null;
  return {
    modelCalls: totals.modelCalls,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    aiCredits: totals.callsWithCredits === 0 ? null : totals.nanoAiu / NANO_AIU_PER_AI_CREDIT,
    aiCreditsPartial: totals.callsWithCredits > 0 && totals.callsWithoutCredits > 0,
    premiumRequests: totals.premiumRequests,
  };
}
