import { REVIEW_UNREAD_MAX, ReviewComment, TaskId } from "@trackwall/protocol";
import { z } from "zod";
import { DomainError } from "../../infra/errors.ts";

/**
 * Review comments the user sent on a task's changes and its agent has not read yet (ADR-62), per task, oldest first.
 * Since ADR-115 they outlive a daemon restart in `agent-queues.json` (`stored`, `restore`), so the resumed task session
 * reads them; every change is reported to `changed`, which writes the file. A comment counts as read once `take`
 * returns it, also when the agent's call is cancelled before the result reaches it.
 */

/** What `agent-queues.json` keeps of the reviews: the unread comments of each task. */
export const StoredReviews = z.array(z.object({ task: TaskId, comments: z.array(ReviewComment).max(REVIEW_UNREAD_MAX) }));
export type StoredReviews = z.infer<typeof StoredReviews>;

export class TaskReviews {
  readonly #unread = new Map<string, ReviewComment[]>();
  readonly #changed: () => void;

  constructor(changed: () => void) {
    this.#changed = changed;
  }

  stored(): StoredReviews {
    return [...this.#unread].map(([task, comments]) => ({ task, comments }));
  }

  /** The unread comments the previous daemon kept, of the tasks that are still there (`hasTask`). */
  restore(stored: StoredReviews, hasTask: (task: string) => boolean): void {
    this.#unread.clear();
    for (const { task, comments } of stored) if (hasTask(task) && comments.length > 0) this.#unread.set(task, comments);
  }

  /** Adds a review after the unread comments; returns how many are unread now. More than `REVIEW_UNREAD_MAX` is refused. */
  add(task: string, comments: readonly ReviewComment[]): number {
    const unread = [...(this.#unread.get(task) ?? []), ...comments];
    if (unread.length > REVIEW_UNREAD_MAX)
      throw new DomainError(
        "bad_request",
        `the agent has not read ${unread.length - comments.length} comments yet; at most ${REVIEW_UNREAD_MAX} can wait for it`,
      );
    this.#unread.set(task, unread);
    this.#changed();
    return unread.length;
  }

  unread(task: string): number {
    return this.#unread.get(task)?.length ?? 0;
  }

  /** The unread comments, which from now on count as read. */
  take(task: string): ReviewComment[] {
    const unread = this.#unread.get(task);
    if (unread === undefined) return [];
    this.#unread.delete(task);
    this.#changed();
    return unread;
  }
}
