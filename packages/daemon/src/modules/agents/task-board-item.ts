import type { Task, TaskWorkColumn } from "@trackwall/protocol";
import { messageOf } from "../../infra/errors.ts";

/**
 * How the work of tasks moves their board item (ADR-212, §4.18): to "In progress" when the user starts a task on it or
 * gives its agent work again, to "In review" once every open task on it has handed its work over with `report_result`.
 * Only these events of the user and the agent move it, never an agent's request, and `board` keeps an item the user
 * closed where it is. A board that cannot be written (no projects folder) does not fail the event: it is logged.
 */

export interface TaskBoardItemDeps {
  /** `Board.followTasks`: moves the item when its column allows it. */
  move: (item: string, column: TaskWorkColumn) => Promise<unknown>;
  /** Every open task, to tell whether all the tasks on an item are in review. */
  tasks: () => readonly Task[];
  log: (msg: string) => void;
}

export class TaskBoardItem {
  readonly #deps: TaskBoardItemDeps;

  constructor(deps: TaskBoardItemDeps) {
    this.#deps = deps;
  }

  /** The user started tasks on an item: one task, or the parts of a change, which share their item. */
  async started(tasks: readonly Task[]): Promise<void> {
    const items = new Set(tasks.map((task) => task.item));
    for (const item of items) if (item !== null) await this.#move(item, "in_progress");
  }

  /** A task handed its work over; its item goes to review only when no other open task on it is still at work. */
  async handedOver(task: Task): Promise<void> {
    const { item } = task;
    if (item === null) return;
    const onItem = this.#deps.tasks().filter((other) => other.item === item);
    if (onItem.every((other) => other.inReview)) await this.#move(item, "review");
  }

  /** The user gave a task's agent work again after it handed it over. */
  async resumed(task: Task): Promise<void> {
    if (task.item !== null) await this.#move(task.item, "in_progress");
  }

  async #move(item: string, column: TaskWorkColumn): Promise<void> {
    try {
      await this.#deps.move(item, column);
    } catch (err) {
      this.#deps.log(`board item ${item} did not move to ${column}: ${messageOf(err)}`);
    }
  }
}
