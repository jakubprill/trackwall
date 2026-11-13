import { countLabel, RunningTasksWarning, type RunningTasksWarningState, type Session } from "@trackwall/protocol";

/**
 * The warning before a start when too many tasks would run at once (ADR-244): the tasks counted from the listed
 * sessions, which the view keeps live, against the number the daemon gives in `start-options`. Only a warning: the
 * start button stays as it is.
 */

/** The tasks whose session runs now (still stopping counts: its processes still hold the computer). */
export function runningTaskCount(sessions: readonly Pick<Session, "task" | "run">[]): number {
  const tasks = new Set<string>();
  for (const session of sessions) {
    if (session.task !== null && session.run.kind !== "exited") tasks.add(session.task);
  }
  return tasks.size;
}

/**
 * The line under the start options when starting `starting` tasks makes more run than `warning.above`; `null` when it
 * does not, when nothing starts a task, or before the daemon answered.
 */
export function runningTasksWarningNote(
  sessions: readonly Pick<Session, "task" | "run">[],
  warning: RunningTasksWarningState | undefined,
  starting: number,
): string | null {
  if (warning === undefined || starting < 1) return null;
  const running = runningTaskCount(sessions);
  const total = running + starting;
  if (total <= warning.above) return null;
  const already = running === 0 ? "No task is running yet" : `${countLabel(running, TASKS)} already ${running === 1 ? "runs" : "run"}`;
  const these = starting === 1 ? "this one makes" : `these ${starting} make`;
  return (
    `${already}; ${these} ${total}, more than the ${warning.above} this computer is set to warn above. ` +
    "Tasks share its processors and memory, so their builds, tests and your editor may slow down. " +
    "You can still start; Settings › Agents changes the number."
  );
}

const TASKS = { one: "task", other: "tasks" };

/** The number typed in Settings › Agents, a whole number from 1 to 100; a message for anything else. */
export function parseRunningTasksWarning(text: string): { above: number } | { problem: string } {
  const trimmed = text.trim();
  const parsed = RunningTasksWarning.safeParse(/^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN);
  return parsed.success ? { above: parsed.data } : { problem: "Type a whole number of tasks from 1 to 100, such as 4." };
}

/** What Settings says the computer's default is, e.g. "4 on this computer (8 processors, 15.6 GiB of memory)". */
export function computerDefaultLabel(warning: RunningTasksWarningState): string {
  return `${warning.computerDefault} on this computer (${countLabel(warning.processors, PROCESSORS)}, ${warning.memoryGiB} GiB of memory)`;
}

const PROCESSORS = { one: "processor", other: "processors" };
