import { type Session, type SessionTokenBudget, TaskTokenBudget } from "@trackwall/protocol";
import { tokenCount } from "@/lib/copilot-usage";

/**
 * How the UI shows a task's token budget (ADR-237): what this start used of it next to the usage, the strip once the
 * daemon stopped the session at it, and the amount typed in Settings, where "2M" and "500k" save as 2000000 and 500000.
 */

const UNITS: Readonly<Record<string, number>> = { "": 1, k: 1000, m: 1_000_000 };

/**
 * The amount typed in Settings, e.g. `2M`, `500k`, `1.5m`, `2 000 000` or `2,000,000`; a message for anything else. A
 * comma counts only between groups of three digits, so a decimal comma (`1,5M`) is refused rather than read as 15M.
 */
export function parseTokenBudget(text: string): { budget: number } | { problem: string } {
  const compact = text.replace(/[\s_]/g, "");
  const grouped = /^(\d{1,3}(?:,\d{3})+)([km]?)$/i.exec(compact);
  const ungrouped = grouped === null ? compact : `${grouped[1]?.replaceAll(",", "")}${grouped[2]}`;
  const match = /^(\d+(?:\.\d+)?)([km]?)$/i.exec(ungrouped);
  const unit = UNITS[match?.[2]?.toLowerCase() ?? ""];
  if (match === null || unit === undefined) return { problem: "Type a number of tokens, such as 2000000, 2M or 500k." };
  const parsed = TaskTokenBudget.safeParse(Math.round(Number(match[1]) * unit));
  return parsed.success ? { budget: parsed.data } : { problem: "The budget must be a whole number of tokens above zero." };
}

/** The mark next to the usage, e.g. "1.2M of 2M tokens"; its tooltip says what counts. */
export function tokenBudgetLabel({ budget, used }: SessionTokenBudget): { label: string; title: string } {
  return {
    label: `${tokenCount(used)} of ${tokenCount(budget)} tokens`,
    title: "The task's token budget: tokens in and out since this start or resume. Trackwall stops the task when it reaches it.",
  };
}

/** The strip of a task's session the daemon stopped at its budget; `null` while it has not reached it. */
export function tokenBudgetNote(session: Pick<Session, "tokenBudget">): { title: string; detail: string } | null {
  const budget = session.tokenBudget;
  if (budget === null || !budget.reached) return null;
  return {
    title: `Stopped at its token budget: ${tokenCount(budget.used)} of ${tokenCount(budget.budget)} tokens`,
    detail: `Resume goes on with the same conversation and gives the task another ${tokenCount(budget.budget)} tokens. Settings › Agents changes the budget.`,
  };
}
