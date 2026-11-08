import {
  COPILOT_AUTO_MODEL,
  type CopilotUsage,
  type EndedTask,
  MODEL_STATS_PERIOD_DAYS,
  type ModelStats,
  type ModelStatsPeriod,
  type ModelStatsRow,
  sumUsage,
} from "@trackwall/protocol";

/**
 * Model statistics (§4.19, ADR-231): the journal's records of a period grouped by the model Copilot CLI ran each task
 * on. A task counts for one model only, the one that made the most of its own calls (`models[0]`, ADR-228), because the
 * requested model is not always the one that did the work (ADR-225) and a task split between models has one outcome.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** The statistics of the records that ended in `period` before `now`. */
export function modelStats(records: readonly EndedTask[], period: ModelStatsPeriod, now: Date): ModelStats {
  const days = MODEL_STATS_PERIOD_DAYS[period];
  const since = days === null ? null : now.getTime() - days * DAY_MS;
  const inPeriod = records.filter((r) => since === null || Date.parse(r.endedAt) >= since);
  const byModel = new Map<string, EndedTask[]>();
  let withoutModel = 0;
  for (const record of inPeriod) {
    const model = record.models[0]?.model;
    if (model === undefined) {
      withoutModel++;
      continue;
    }
    const tasks = byModel.get(model);
    if (tasks === undefined) byModel.set(model, [record]);
    else tasks.push(record);
  }
  const models = [...byModel]
    .map(([model, tasks]) => row(model, tasks))
    .sort((a, b) => b.tasks - a.tasks || a.model.localeCompare(b.model));
  return { period, models, withoutModel };
}

function row(model: string, tasks: readonly EndedTask[]): ModelStatsRow {
  const usages = tasks.flatMap((t): CopilotUsage[] => (t.usage === null ? [] : [t.usage]));
  return {
    model,
    tasks: tasks.length,
    verified: tasks.filter((t) => t.verification?.state === "passed").length,
    failed: tasks.filter((t) => t.verification?.state === "failed").length,
    withCommits: tasks.filter((t) => (t.commitsTotal ?? t.commits.length) > 0).length,
    askedForAnother: tasks.filter((t) => t.model !== null && t.model !== COPILOT_AUTO_MODEL && t.model !== model).length,
    sharedWithAnother: tasks.filter((t) => t.models.length > 1).length,
    usage: sumUsage(usages),
    tasksWithUsage: usages.length,
    tasksWithCredits: usages.filter((u) => u.aiCredits !== null).length,
  };
}
