import { type CopilotUsage, countLabel, type Session, sumUsage } from "@trackwall/protocol";

/**
 * How the UI shows what a session's Copilot CLI conversation used (ADR-190): AI credits when Copilot CLI reported them,
 * premium requests on the legacy billing, and only the tokens with a model of your own provider (BYOK).
 */

const CREDITS = { one: "AI credit", other: "AI credits" };
const PREMIUM_REQUESTS = { one: "premium request", other: "premium requests" };
const MODEL_CALLS = { one: "model call", other: "model calls" };

/** Two decimals below 10, one below 100 and none above, as Copilot CLI's footer rounds them. */
function amount(n: number): string {
  if (n < 10) return String(Math.round(n * 100) / 100);
  if (n < 100) return String(Math.round(n * 10) / 10);
  return String(Math.round(n));
}

/** 950, 1.2k, 3.4M. */
export function tokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 100) / 10}k`;
  return `${Math.round(n / 100_000) / 10}M`;
}

/** The short label, e.g. "12.5 AI credits", "at least 3.2 AI credits", "4 premium requests", "1.2k tokens". */
export function usageLabel(usage: CopilotUsage): string {
  if (usage.aiCredits !== null) {
    const credits = `${amount(usage.aiCredits)} ${usage.aiCredits === 1 ? CREDITS.one : CREDITS.other}`;
    return usage.aiCreditsPartial ? `at least ${credits}` : credits;
  }
  if (usage.premiumRequests > 0)
    return `${amount(usage.premiumRequests)} ${usage.premiumRequests === 1 ? PREMIUM_REQUESTS.one : PREMIUM_REQUESTS.other}`;
  return `${tokenCount(usage.inputTokens + usage.outputTokens)} tokens`;
}

/** The tooltip: the calls and tokens behind the label, and why there are no credits when there are none. */
export function usageDetails(usage: CopilotUsage): string {
  const lines = [
    `${countLabel(usage.modelCalls, MODEL_CALLS)} in this conversation`,
    `${tokenCount(usage.inputTokens)} tokens in, ${tokenCount(usage.outputTokens)} out`,
  ];
  if (usage.aiCreditsPartial) lines.push("Some calls did not report AI credits, so the total may be higher");
  if (usage.aiCredits === null && usage.premiumRequests === 0)
    lines.push("Copilot CLI reported no AI credits: a model of your own provider, or a plan without them");
  return lines.join("\n");
}

/**
 * The sum over the listed sessions, for the Sessions list; `null` when none reported usage. A session that resumed the
 * same conversation as an older listed one (a task resumed) counts once, by keeping the newest of each task.
 */
export function listedUsage(sessions: readonly Session[]): CopilotUsage | null {
  const seenTasks = new Set<string>();
  const counted: CopilotUsage[] = [];
  for (const session of sessions) {
    if (session.task !== null) {
      if (seenTasks.has(session.task)) continue;
      seenTasks.add(session.task);
    }
    if (session.usage !== null) counted.push(session.usage);
  }
  return sumUsage(counted);
}
