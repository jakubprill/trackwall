import { z } from "zod";
import { apiEndpoints } from "./api.ts";
import { CopilotUsage } from "./copilot-usage.ts";

/**
 * Model statistics (ADR-231): the task journal's ended tasks (§4.19, ADR-228) grouped by the model Copilot CLI ran
 * them on, with how they ended and what they cost, so the user can see which model finishes work they can keep and at
 * what price, from their own tasks rather than from a benchmark. Every action is `POST /api/task-journal/<action>`.
 */

/** The ended tasks the statistics cover: those ended in the last 30 or 90 days, or every record the journal keeps. */
export const ModelStatsPeriod = z.enum(["30d", "90d", "all"]);
export type ModelStatsPeriod = z.infer<typeof ModelStatsPeriod>;

/** Days in a period; `null` for the whole journal. */
export const MODEL_STATS_PERIOD_DAYS: Record<ModelStatsPeriod, number | null> = { "30d": 30, "90d": 90, all: null };

/**
 * Fewer tasks than this on a model are too few to compare it by: one failed verification moves its share by a fifth or
 * more.
 */
export const MODEL_STATS_FEW_TASKS = 5;

/** The ended tasks one model is credited with: the model that made the most of a task's own calls. */
export const ModelStatsRow = z.object({
  model: z.string(),
  tasks: z.number().int().positive(),
  /** Tasks whose last verification passed. */
  verified: z.number().int().nonnegative(),
  /** Tasks whose last verification failed. */
  failed: z.number().int().nonnegative(),
  /** Tasks that left at least one commit on their branch. */
  withCommits: z.number().int().nonnegative(),
  /** Tasks the user started on another model, which Copilot CLI ran on this one instead (ADR-225). */
  askedForAnother: z.number().int().nonnegative(),
  /** Tasks that also ran on another model (after `/model` or a restart), credited here by the most calls. */
  sharedWithAnother: z.number().int().nonnegative(),
  /** Tasks the user kept over another attempt at the same task, compared side by side (ADR-252). */
  keptInComparison: z.number().int().nonnegative(),
  /** Tasks the user ended because they kept another attempt at the same task (ADR-252). */
  droppedInComparison: z.number().int().nonnegative(),
  /** What the tasks used together; `null` when none of them has its usage recorded. */
  usage: CopilotUsage.nullable(),
  /** Tasks whose usage is in `usage`. */
  tasksWithUsage: z.number().int().nonnegative(),
  /** Of those, the tasks that reported AI credits, which `usage.aiCredits` sums. */
  tasksWithCredits: z.number().int().nonnegative(),
});
export type ModelStatsRow = z.infer<typeof ModelStatsRow>;

export const ModelStats = z.object({
  period: ModelStatsPeriod,
  /** One row per model, the most tasks first. */
  models: z.array(ModelStatsRow),
  /**
   * Ended tasks of the period with no model recorded: ended before Trackwall kept it, or Copilot CLI's log of the
   * conversation was missing; they are in no row.
   */
  withoutModel: z.number().int().nonnegative(),
});
export type ModelStats = z.infer<typeof ModelStats>;

const endpoint = apiEndpoints("task-journal");

export const taskJournalApi = {
  modelStats: endpoint("model-stats", z.object({ period: ModelStatsPeriod }).strict(), ModelStats),
};
