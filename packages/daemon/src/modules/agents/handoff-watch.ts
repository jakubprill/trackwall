import type { TaskHandoffState } from "@trackwall/protocol";
import { messageOf } from "../../infra/errors.ts";

/**
 * Which tasks wait to hear that the branch of the task that handed them their work moved (§4.4, ADR-144): the handing
 * task's turn ends, or a subtask's session starts, and a subtask whose last read commit differs from that branch's head
 * is asked to call `get_handoff`, which clears the wait. Memory only: git keeps the facts, so a session start after a
 * daemon restart finds the move again.
 */

/** What the watch needs from the task list (`AgentTasks`). */
export interface HandoffTasks {
  /** The tasks task `task` handed their work to. */
  handedTo(task: string): string[];
  /** Whether the handing task's branch is at another commit than the one task `task` read last. */
  handoffMoved(task: string): Promise<boolean>;
  /** The handoff state of task `task`, whose head then counts as read. */
  readHandoff(task: string): Promise<TaskHandoffState | null>;
}

export class HandoffWatch {
  readonly #tasks: HandoffTasks;
  /** Asks the running session of a task, if any, to read what waits for it. */
  readonly #askToRead: (task: string) => void;
  readonly #log: (message: string) => void;
  readonly #waiting = new Set<string>();
  /** Reads started per task: a check that compared before a read does not mark the task after it. */
  readonly #reads = new Map<string, number>();

  constructor(tasks: HandoffTasks, askToRead: (task: string) => void, log: (message: string) => void) {
    this.#tasks = tasks;
    this.#askToRead = askToRead;
    this.#log = log;
  }

  /** Whether task `task` is to be asked to call `get_handoff`. */
  waiting(task: string): boolean {
    return this.#waiting.has(task);
  }

  /** Task `task`'s agent ended a turn, so its branch may have moved for each task it handed work to. */
  async turnOver(task: string): Promise<void> {
    for (const subtask of this.#tasks.handedTo(task)) await this.check(subtask);
  }

  /** Marks task `task` and asks its session to read, when its handing task's branch moved since it last read it. */
  async check(task: string): Promise<void> {
    if (this.#waiting.has(task)) return;
    const reads = this.#reads.get(task) ?? 0;
    try {
      if (!(await this.#tasks.handoffMoved(task))) return;
    } catch (err) {
      this.#log(`task ${task}: checking the branch of the task that handed it its work: ${messageOf(err)}`);
      return;
    }
    if (this.#waiting.has(task) || (this.#reads.get(task) ?? 0) !== reads) return;
    this.#waiting.add(task);
    this.#askToRead(task);
  }

  /** `get_handoff`: the wait ends once the read succeeded, so a failed read is asked for again. */
  async read(task: string): Promise<TaskHandoffState | null> {
    this.#reads.set(task, (this.#reads.get(task) ?? 0) + 1);
    const state = await this.#tasks.readHandoff(task);
    this.#waiting.delete(task);
    return state;
  }

  forget(task: string): void {
    this.#waiting.delete(task);
    this.#reads.delete(task);
  }
}
