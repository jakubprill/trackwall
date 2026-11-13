import { ancestorsOf, type BoardColumn, type BoardItem, type Session, type Task, type TaskOutcome } from "@trackwall/protocol";
import { isClosed, outline } from "./board-tree.ts";
import type { StatusTone } from "./repo-status.ts";
import { latestSession } from "./session-entries.ts";
import { taskStateLabel } from "./session-state.ts";
import { type OutcomeMark, outcomeMarks } from "./task-outcomes.ts";

/**
 * How far a project of Plan is and what its tasks are doing now (ADR-215): the counts of its items by column, the done
 * share, how many tasks wait for the user, and on each item the state of the newest session of each task started on it,
 * with the task's outcome marks. Everything comes from the board, the session list and the task outcomes the UI already
 * has; nothing here is stored.
 */

/**
 * The columns as a project's bar shows them, left to right, from finished work to work not yet started; "Dropped" is not
 * among them, since that work is not to be done.
 */
export const PROGRESS_COLUMNS: readonly BoardColumn[] = ["done", "review", "in_progress", "ready", "ideas"];

export interface Progress {
  /** Items that are to be done: every item below, without the dropped ones. */
  total: number;
  done: number;
  byColumn: Record<BoardColumn, number>;
}

/**
 * The items below `parent` (a project or an item), at any depth, counted by column. An item below a done or dropped one
 * counts in that item's column, as "Hide done" hides it with it: closing an item closes what it was split into.
 */
export function progressBelow(items: readonly BoardItem[], parent: string): Progress {
  const byColumn: Record<BoardColumn, number> = { ideas: 0, ready: 0, in_progress: 0, review: 0, done: 0, dropped: 0 };
  for (const { item } of outline(items, parent)) byColumn[countedColumn(items, item, parent)] += 1;
  return { total: Object.values(byColumn).reduce((sum, n) => sum + n, 0) - byColumn.dropped, done: byColumn.done, byColumn };
}

/**
 * The column an item below `parent` counts in: its own, or that of the nearest done or dropped item between it and
 * `parent`, since closing an item closes what it was split into (ADR-215).
 */
export function countedColumn(items: readonly BoardItem[], item: BoardItem, parent: string): BoardColumn {
  const above = ancestorsOf(items, item);
  return above.slice(above.findIndex((it) => it.id === parent) + 1).find(isClosed)?.column ?? item.column;
}

/** "2 of 9 done", or `undefined` when nothing below is to be done. */
export function progressLabel(progress: Progress): string | undefined {
  return progress.total === 0 ? undefined : `${progress.done} of ${progress.total} done`;
}

/** What the UI knows of tasks now: the tasks, the sessions (newest first) and the tasks' outcomes. */
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
  /**
   * The agent asks something of the user, or handed its work over for review (ADR-213). Wider than the attention count of
   * Sessions, which counts only questions: on a plan, a task in review is work that waits for the user too.
   */
  waitsForYou: boolean;
}

/** The tasks of each item, newest first: built once from what the UI knows, so the outline does not search per row. */
export type ItemTaskIndex = ReadonlyMap<string, readonly ItemTask[]>;

/** Each task started on an item, with its state; a task without a session reads "no session". */
export function itemTaskIndex({ tasks, sessions, outcomes }: TaskActivity): ItemTaskIndex {
  const index = new Map<string, ItemTask[]>();
  const newestFirst = [...tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const task of newestFirst) {
    if (task.item === null) continue;
    const session = latestSession(sessions, task.id);
    const listed = index.get(task.item) ?? [];
    listed.push({
      task,
      session,
      state: taskStateLabel(task, session),
      marks: outcomeMarks(outcomes.get(task.id), task.inReview),
      waitsForYou: task.inReview || session?.needsAttention === true,
    });
    index.set(task.item, listed);
  }
  return index;
}

/** The tasks started on `item`, newest first. */
export function itemTasks(item: string, index: ItemTaskIndex): readonly ItemTask[] {
  return index.get(item) ?? [];
}

/** The tasks started on the items below `parent` (not on itself), in outline order, for the item's "Tasks below". */
export function tasksBelow(items: readonly BoardItem[], parent: string, index: ItemTaskIndex): ItemTask[] {
  return outline(items, parent).flatMap(({ item }) => itemTasks(item.id, index));
}

/** How many tasks started on the project's items wait for the user, for its header and its line in the left column. */
export function tasksWaiting(items: readonly BoardItem[], project: string, index: ItemTaskIndex): number {
  return tasksBelow(items, project, index).filter((t) => t.waitsForYou).length;
}

/**
 * The task a row shows: one that waits for the user before the newest, so an older task's question is not hidden behind
 * a newer one that is working.
 */
export function rowTask(tasks: readonly ItemTask[]): ItemTask | undefined {
  return tasks.find((t) => t.waitsForYou) ?? tasks[0];
}

/** Whether a row hides under "Hide done": done or dropped, or below such an item. */
export function hiddenAsDone(items: readonly BoardItem[], item: BoardItem): boolean {
  return [...ancestorsOf(items, item), item].some((it) => it.kind === "item" && isClosed(it));
}
