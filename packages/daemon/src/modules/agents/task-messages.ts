import { randomUUID } from "node:crypto";
import { type ProposedBy, TASK_MESSAGES_KEPT, TASK_MESSAGES_WITHOUT_USER, TaskMessage } from "@trackwall/protocol";
import { z } from "zod";
import { DomainError } from "../../infra/errors.ts";

/**
 * Task messages (ADR-68): what a task's proposer sent its session with `send_message`, per task, oldest first. The last
 * `TASK_MESSAGES_KEPT` of a task stay, read ones included, so the task panel shows the user what the agents told each
 * other. Since ADR-115 they outlive a daemon restart in `agent-queues.json` (`list`, `restore`); every change is
 * reported to `changed`, which writes the file. A message counts as read once `take` returns it, also when the agent's
 * call is cancelled before the result reaches it.
 */

/** What `agent-queues.json` keeps of the messages: every kept one, as `list` gives them. */
export const StoredMessages = z.array(TaskMessage);
export type StoredMessages = z.infer<typeof StoredMessages>;

export class TaskMessages {
  readonly #byTask = new Map<string, TaskMessage[]>();
  readonly #changed: () => void;

  constructor(changed: () => void) {
    this.#changed = changed;
  }

  /** The messages the previous daemon kept, of the tasks that are still there (`hasTask`), at most `TASK_MESSAGES_KEPT` of each. */
  restore(stored: StoredMessages, hasTask: (task: string) => boolean): void {
    this.#byTask.clear();
    for (const message of stored) {
      if (!hasTask(message.task)) continue;
      this.#byTask.set(message.task, [...(this.#byTask.get(message.task) ?? []), message].slice(-TASK_MESSAGES_KEPT));
    }
  }

  /**
   * Adds a message, refused while `TASK_MESSAGES_KEPT` of the task's messages are unread, or when
   * `TASK_MESSAGES_WITHOUT_USER` were sent to it since `userTookPartAt` (milliseconds since the epoch).
   */
  add(task: string, from: ProposedBy, text: string, userTookPartAt: number): TaskMessage {
    const kept = this.#byTask.get(task) ?? [];
    if (kept.filter((m) => m.readAt === null).length >= TASK_MESSAGES_KEPT)
      throw new DomainError(
        "bad_request",
        `${TASK_MESSAGES_KEPT} messages to task ${task} are still unread; wait until its agent reads them`,
      );
    if (kept.filter((m) => Date.parse(m.sentAt) > userTookPartAt).length >= TASK_MESSAGES_WITHOUT_USER)
      throw new DomainError(
        "bad_request",
        `${TASK_MESSAGES_WITHOUT_USER} messages went to task ${task} since the user last took part; ask the user before you send more`,
      );
    const message: TaskMessage = { id: randomUUID(), task, from, text, sentAt: new Date().toISOString(), readAt: null };
    const next = [...kept, message];
    // The unread ones are fewer than the limit (checked above), so a read one makes room; the unread are never dropped.
    if (next.length > TASK_MESSAGES_KEPT) {
      const oldestRead = next.findIndex((m) => m.readAt !== null);
      if (oldestRead === -1) throw new Error(`task ${task} keeps more than ${TASK_MESSAGES_KEPT} messages and none is read`);
      next.splice(oldestRead, 1);
    }
    this.#byTask.set(task, next);
    this.#changed();
    return message;
  }

  unread(task: string): number {
    return this.#byTask.get(task)?.filter((m) => m.readAt === null).length ?? 0;
  }

  /** The unread messages, which from now on count as read. */
  take(task: string): TaskMessage[] {
    const kept = this.#byTask.get(task) ?? [];
    const unread = kept.filter((m) => m.readAt === null);
    if (unread.length === 0) return [];
    const readAt = new Date().toISOString();
    this.#byTask.set(
      task,
      kept.map((m) => (m.readAt === null ? { ...m, readAt } : m)),
    );
    this.#changed();
    return unread;
  }

  /** Every kept message, task by task, oldest first within a task. */
  list(): TaskMessage[] {
    return [...this.#byTask.values()].flat();
  }

  /** An ended task takes its messages with it. */
  drop(task: string): void {
    if (this.#byTask.delete(task)) this.#changed();
  }
}
