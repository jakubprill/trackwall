import type { DayStartRun, DayStartStep } from "@trackwall/protocol";

/** The day start in the UI (ADR-70): what its button says while it runs; tests in `test/day-start.test.ts`. */

const STEP_LABEL: Record<DayStartStep, string> = {
  sync: "Syncing repos…",
  report: "Writing the day report…",
  supervisor: "Starting the supervisor…",
};

const DAY_START_LABEL = "Start my day";

/** The button's text: the running step, otherwise its own name. */
export function dayStartLabel(run: DayStartRun | null | undefined): string {
  return run?.finishedAt === null ? STEP_LABEL[run.step] : DAY_START_LABEL;
}

/**
 * Why the last day start stopped; `undefined` while it runs, after one that started the supervisor, and once a
 * supervisor started after it (`supervisorStartedAt`), whose own state the panel shows instead.
 */
export function dayStartFailure(run: DayStartRun | null | undefined, supervisorStartedAt: string | undefined): string | undefined {
  if (!run || run.finishedAt === null || run.error === null) return undefined;
  if (supervisorStartedAt !== undefined && Date.parse(supervisorStartedAt) >= Date.parse(run.finishedAt)) return undefined;
  return `Start my day stopped while ${STEP_DOING[run.step]}: ${run.error}`;
}

const STEP_DOING: Record<DayStartStep, string> = {
  sync: "syncing the repos",
  report: "writing the day report",
  supervisor: "starting the supervisor",
};
