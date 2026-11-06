import { ancestorsOf, type BoardColumn, type BoardItem, type Session, type Task, type TaskOutcome } from "@trackwall/protocol";
import { outline } from "./board-tree.ts";
import type { StatusTone } from "./repo-status.ts";
import { sessionStateLabel } from "./session-state.ts";
import { type OutcomeMark, outcomeMarks } from "./task-outcomes.ts";

/**
 * How far a project of Plan is and what its tasks are doing now (ADR-215): the counts of its items by column, the done
 * share, how many tasks wait for the user, and on each item the state of the newest session of each task started on it,
 * with the task's outcome marks. Everything comes from the board, the session list and the task outcomes the UI already
 * has; nothing here is stored.
 */

/** The columns as a project's bar shows them, left to right; "Dropped" counts nowhere, since that work is not to be done. */
export const PROGRESS_COLUMNS: readonly BoardColumn[] = ["done", "review", "in_progress", "ready", "ideas"];

export interface Progress {
  /** Items that are to be done: every item below, without the dropped ones. */
  total: number;
  done: number;
  byColumn: Record<BoardColumn, number>;
}

/** The items below `parent` (a project or an item), at any depth, counted by column. */
export function progressBelow(items: readonly BoardItem[], parent: string): Progress {
  const byColumn: Record<BoardColumn, number> = { ideas: 0, ready: 0, in_progress: 0, review: 0, done: 0, dropped: 0 };
  for (const { item } of outline(items, parent)) byColumn[item.column] += 1;
  return { total: Object.values(byColumn).reduce((sum, n) => sum + n, 0) - byColumn.dropped, done: byColumn.done, byColumn };
}

/** "2 of 9 done", or `undefined` when nothing below is to be done. */
export function progressLabel(progress: Progress): string | undefined {
  return progress.total === 0 ? undefined : `${progress.done} of ${progress.total} done`;
}

/** What the UI knows of tasks now: the tasks, the sessions and the tasks' outcomes, handed through Plan as one value. */
export interface TaskActivity {
  tasks: readonly Task[];
  sessions: readonly Session[];
  outcomes: ReadonlyMap<string, TaskOutcome>;
}

/** A task started on an item with what it is doing now: its newest session's state and its outcome marks. */
export interface ItemTask {
  task: Task;
  /** The newest session of the task; `undefined` when none runs or ran since the daemon started. */
  session: Session | undefined;
  state: { tone?: StatusTone; label: string };
  marks: OutcomeMark[];
  /** The agent asks something of the user, or handed its work over for review (ADR-213). */
  waitsForYou: boolean;
}

/** The tasks started on `item`, newest first, each with its state; a task without a session reads "no session". */
export function itemTasks(item: string, { tasks, sessions, outcomes }: TaskActivity): ItemTask[] {
  return tasks
    .filter((task) => task.item === item)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((task) => {
      const session = newestSession(sessions, task.id);
      return {
        task,
        session,
        state: session ? sessionStateLabel(session) : { label: "no session" },
        marks: outcomeMarks(outcomes.get(task.id), task.inReview),
        waitsForYou: task.inReview || session?.needsAttention === true,
      };
    });
}

function newestSession(sessions: readonly Session[], task: string): Session | undefined {
  return sessions.filter((s) => s.task === task).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}

/** The tasks started on the items below `parent` (not on itself), in outline order, for the item's "Tasks below". */
export function tasksBelow(items: readonly BoardItem[], parent: string, activity: TaskActivity): ItemTask[] {
  return outline(items, parent).flatMap(({ item }) => itemTasks(item.id, activity));
}

/** How many tasks started on the project's items wait for the user, for its header and its line in the left column. */
export function tasksWaiting(items: readonly BoardItem[], project: string, activity: TaskActivity): number {
  return outline(items, project)
    .flatMap(({ item }) => itemTasks(item.id, activity))
    .filter((t) => t.waitsForYou).length;
}

/** Whether a row hides under "Hide done": done or dropped, or below such an item. */
export function hiddenAsDone(items: readonly BoardItem[], item: BoardItem): boolean {
  return [...ancestorsOf(items, item), item].some((it) => it.kind === "item" && (it.column === "done" || it.column === "dropped"));
}
