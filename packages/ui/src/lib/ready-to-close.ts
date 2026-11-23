import { agentsApi, countLabel, readyToClose, type Session, type Task } from "@trackwall/protocol";
import { errorMessage, post } from "./api.ts";
import type { Connection } from "./connection.ts";
import { taskName, workingSession } from "./session-entries.ts";

/**
 * Tasks whose agent said its work is over and that the user can close (ADR-282): in one list on Home, so the user does
 * not open every task to find the finished ones. Closing is the user's; the daemon refuses a task it would lose work of,
 * and one whose agent works again, and those stay open for the user to look at.
 */

/**
 * The tasks ready to close now, oldest report first: the agent of each said its work is over and does nothing else. The
 * lead part of a change with one session (ADR-265) comes after the parts it works on, since the daemon ends it only once
 * they are ended, so "Close all" closes a whole change.
 */
export function tasksReadyToClose(tasks: readonly Task[], sessions: readonly Session[]): Task[] {
  const lead = (task: Task) => (task.change?.session === task.id ? 1 : 0);
  return tasks
    .filter((task) => readyToClose(task, workingSession(sessions, task)))
    .sort((a, b) => lead(a) - lead(b) || (a.summary?.reportedAt ?? a.createdAt).localeCompare(b.summary?.reportedAt ?? b.createdAt));
}

/** One task's Close: done, or why the daemon kept it open. */
export interface CloseResult {
  task: Task;
  /** The daemon's refusal; `undefined` once the task is closed. */
  refused?: string;
}

const TASKS = { one: "task", other: "tasks" };

/**
 * The tasks closed one at a time: each Close stops the task's session and removes its worktree, so they do not compete
 * for the disk, and a refused one does not stop the rest.
 */
export async function closeTasks(conn: Connection, tasks: readonly Task[]): Promise<CloseResult[]> {
  const results: CloseResult[] = [];
  for (const task of tasks) {
    try {
      await post(conn, agentsApi.closeTask, { task: task.id });
      results.push({ task });
    } catch (err) {
      results.push({ task, refused: errorMessage(err) });
    }
  }
  return results;
}

/** What "Close all" did, in one line: how many it closed, and each task it left open with why. */
export function closeOutcome(results: readonly CloseResult[]): string {
  const closed = results.filter((r) => r.refused === undefined).length;
  const open = results.filter((r) => r.refused !== undefined);
  const done = `Closed ${countLabel(closed, TASKS)}.`;
  if (open.length === 0) return done;
  const why = open.map((r) => `${r.task.repo} · ${taskName(r.task)}: ${r.refused}`).join("; ");
  return `${done} Still open, ${countLabel(open.length, TASKS)}: ${why}.`;
}
