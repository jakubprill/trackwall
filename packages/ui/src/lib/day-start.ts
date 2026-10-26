import type { DayStartRun, DayStartStep } from "@trackwall/protocol";

/**
 * The day start in the UI (ADR-70): what its button says while it runs, and which start error the supervisor panel shows;
 * tests in `test/day-start.test.ts`.
 */

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

/** The supervisor panel's two start buttons: a plain start of the supervisor, and Start my day. */
export type StartButton = "supervisor" | "day";

/**
 * The error of the start button the user pressed last, because an older one of the other button says nothing about now.
 * For Start my day that is the request's own error or, since the daemon keeps a failed day start beyond the panel's
 * life, `dayStartFailure`.
 */
export function startErrorShown(state: {
  lastStart: StartButton;
  supervisorError: string | undefined;
  dayError: string | undefined;
  dayRun: DayStartRun | null | undefined;
  supervisorStartedAt: string | undefined;
}): string | undefined {
  if (state.lastStart === "supervisor") return state.supervisorError;
  return state.dayError ?? dayStartFailure(state.dayRun, state.supervisorStartedAt);
}
