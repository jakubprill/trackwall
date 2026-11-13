import {
  type CopilotUsage,
  countLabel,
  MODEL_STATS_FEW_TASKS,
  type ModelStats,
  type ModelStatsPeriod,
  type ModelStatsRow,
} from "@trackwall/protocol";
import { usageLabel } from "./copilot-usage.ts";

/**
 * How Settings shows the model statistics (ADR-231): shares of a model's tasks, what one task and one verified task cost
 * on it, and the one sentence that answers the question the view is for: which model to start the next task on.
 */

export const MODEL_STATS_PERIOD_LABELS: Record<ModelStatsPeriod, string> = { "30d": "30 days", "90d": "90 days", all: "All" };

const TASKS = { one: "task", other: "tasks" };

/** "3 of 5 · 60%"; "0 of 5" without a percent. */
export function share(part: number, whole: number): string {
  if (part === 0) return `0 of ${whole}`;
  return `${part} of ${whole} · ${Math.round((part / whole) * 100)}%`;
}

/** Too few tasks on a model to compare it by: one more failed verification moves its share by a fifth or more. */
export function fewTasks(row: Pick<ModelStatsRow, "tasks">): boolean {
  return row.tasks < MODEL_STATS_FEW_TASKS;
}

/**
 * What one task cost on average, over the tasks whose usage is recorded; AI credits over the tasks that reported them,
 * so a task without credits (a model of your own provider) does not pull the average down. `null` when none is.
 */
export function perTask(row: ModelStatsRow): CopilotUsage | null {
  if (row.usage === null || row.tasksWithUsage === 0) return null;
  const { aiCredits } = row.usage;
  const average = scaled(row.usage, 1 / row.tasksWithUsage);
  return { ...average, aiCredits: aiCredits === null || row.tasksWithCredits === 0 ? null : aiCredits / row.tasksWithCredits };
}

/** The tooltip of "Per task": what the average is over. */
export function perTaskDetails(row: ModelStatsRow): string {
  const missing = row.tasks - row.tasksWithUsage;
  const over = `The average of ${countLabel(row.tasksWithUsage, TASKS)} with recorded usage`;
  return missing === 0 ? over : `${over}; ${countLabel(missing, TASKS)} without it ${missing === 1 ? "is" : "are"} left out`;
}

/** The tooltip of "Per verified task": how it is counted. */
export function perVerifiedTaskDetails(row: ModelStatsRow): string {
  return `What all ${countLabel(row.tasks, TASKS)} cost, over the ${row.verified} that passed verification`;
}

/**
 * What one passed verification cost: everything spent on the model's tasks, the failed and unverified ones included,
 * over the tasks that passed; the average task stands in for the tasks without recorded usage. `null` when none passed.
 */
export function perVerifiedTask(row: ModelStatsRow): CopilotUsage | null {
  const average = perTask(row);
  if (average === null || row.verified === 0) return null;
  return scaled(average, row.tasks / row.verified);
}

/**
 * Notes on how a model got its tasks (started on another model, or split between models) and how its attempts fared
 * when the user compared them with another attempt at the same task (ADR-252).
 */
export function rowNotes(row: ModelStatsRow): string[] {
  const notes: string[] = [];
  if (row.askedForAnother > 0) notes.push(`${countLabel(row.askedForAnother, TASKS)} started on another model`);
  if (row.sharedWithAnother > 0) notes.push(`${countLabel(row.sharedWithAnother, TASKS)} also ran on another model`);
  const compared = row.keptInComparison + row.droppedInComparison;
  if (compared > 0) notes.push(`kept in ${row.keptInComparison} of ${countLabel(compared, { one: "comparison", other: "comparisons" })}`);
  return notes;
}

/**
 * The answer the statistics are for, from the models with enough tasks to compare: the one that passes verification
 * most often and the one whose passed verification costs the fewest AI credits. `null` when fewer than two models can
 * be compared, since a single model is not a choice, or when none of them passed a verification. On a tie the model
 * listed first, the one with more tasks, wins.
 */
export function verdict(stats: ModelStats): string | null {
  const comparable = stats.models.filter((row) => !fewTasks(row));
  if (comparable.length < 2) return null;
  const rate = (row: ModelStatsRow) => row.verified / row.tasks;
  const mostVerified = comparable.reduce((best, row) => (rate(row) > rate(best) ? row : best));
  if (mostVerified.verified === 0) return null;
  const sentences = [`${mostVerified.model} passes verification most often (${Math.round(rate(mostVerified) * 100)}% of its tasks).`];
  const priced = comparable.flatMap((row) => {
    const cost = perVerifiedTask(row);
    if (cost === null || cost.aiCredits === null) return [];
    return [{ row, cost, credits: cost.aiCredits }];
  });
  if (priced.length >= 2) {
    const cheapest = priced.reduce((best, p) => (p.credits < best.credits ? p : best));
    sentences.push(`${cheapest.row.model} costs the least per verified task (${usageLabel(cheapest.cost)}).`);
  }
  return sentences.join(" ");
}

/** A note under the table on the tasks that are in no row, or `null` when every task is in one. */
export function withoutModelNote(stats: ModelStats): string | null {
  if (stats.withoutModel === 0) return null;
  return `${countLabel(stats.withoutModel, { one: "ended task has", other: "ended tasks have" })} no model recorded (ended before Trackwall kept it, or Copilot CLI's log was missing), so ${stats.withoutModel === 1 ? "it is" : "they are"} not counted.`;
}

function scaled(usage: CopilotUsage, factor: number): CopilotUsage {
  return {
    modelCalls: Math.round(usage.modelCalls * factor),
    inputTokens: Math.round(usage.inputTokens * factor),
    outputTokens: Math.round(usage.outputTokens * factor),
    aiCredits: usage.aiCredits === null ? null : usage.aiCredits * factor,
    aiCreditsPartial: usage.aiCreditsPartial,
    premiumRequests: usage.premiumRequests * factor,
  };
}
