import type { BoardItem, Task, TaskWorkColumn } from "@trackwall/protocol";
import { messageOf } from "../../infra/errors.ts";

/**
 * How the work of tasks moves their board item (ADR-213, §4.18): to "In progress" when a task starts on it or its agent
 * gets work again, to "In review" once every open task on it has handed its work over with `report_result`, and back
 * to "Ready" when the last task on it is removed before it handed anything over (ADR-213). Only these
 * events move it, never an agent's request, and `board` keeps an item the user closed where it is. The moves run in the
 * background, in order (the board writes one at a time), so a task's start, report or review never waits for the
 * projects folder; one that cannot be written is logged.
 */

export interface TaskBoardItemDeps {
  /** `Board.followTasks`: moves the item when its column allows it, `null` when it stays. */
  move: (item: string, column: TaskWorkColumn) => Promise<BoardItem | null>;
  /** Every open task, to tell whether all the tasks on an item are in review. */
  tasks: () => readonly Task[];
  log: (msg: string) => void;
}

export class TaskBoardItem {
  readonly #deps: TaskBoardItemDeps;

  constructor(deps: TaskBoardItemDeps) {
    this.#deps = deps;
  }

  started(task: Task): void {
    if (task.item !== null) this.#move(task.item, "in_progress");
  }

  handedOver(task: Task): void {
    if (task.item !== null) this.settle(task.item);
  }

  /**
   * A task on the item was removed: with none left, an item still in progress goes back to ready, since nobody works on
   * it any more; with others left, it goes to review when they all are.
   */
  removed(item: string): void {
    if (this.#deps.tasks().some((task) => task.item === item)) this.settle(item);
    else this.#move(item, "ready");
  }

  /** The item goes to review when it has open tasks and all of them are in review; otherwise it stays. */
  settle(item: string): void {
    const onItem = this.#deps.tasks().filter((task) => task.item === item);
    if (onItem.length > 0 && onItem.every((task) => task.inReview)) this.#move(item, "review");
  }

  backToWork(task: Task): void {
    if (task.item !== null) this.#move(task.item, "in_progress");
  }

  #move(item: string, column: TaskWorkColumn): void {
    this.#deps.move(item, column).catch((err) => this.#deps.log(`board item ${item} did not move to ${column}: ${messageOf(err)}`));
  }
}
