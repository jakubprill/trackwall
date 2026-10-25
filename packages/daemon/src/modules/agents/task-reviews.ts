import { REVIEW_UNREAD_MAX, type ReviewComment } from "@trackwall/protocol";
import { DomainError } from "../../infra/errors.ts";

/**
 * Review comments the user sent on a task's changes and its agent has not read yet (ADR-62), per task, oldest first.
 * Only in daemon memory, like task proposals: a daemon restart drops the unread ones, and the user sends them again.
 * A comment counts as read once `take` returns it, also when the agent's call is cancelled before the result reaches it.
 */
export class TaskReviews {
  readonly #unread = new Map<string, ReviewComment[]>();

  /** Adds a review after the unread comments; returns how many are unread now. More than `REVIEW_UNREAD_MAX` is refused. */
  add(task: string, comments: readonly ReviewComment[]): number {
    const unread = [...(this.#unread.get(task) ?? []), ...comments];
    if (unread.length > REVIEW_UNREAD_MAX)
      throw new DomainError(
        "bad_request",
        `the agent has not read ${unread.length - comments.length} comments yet; at most ${REVIEW_UNREAD_MAX} can wait for it`,
      );
    this.#unread.set(task, unread);
    return unread.length;
  }

  unread(task: string): number {
    return this.#unread.get(task)?.length ?? 0;
  }

  /** The unread comments, which from now on count as read. */
  take(task: string): ReviewComment[] {
    const unread = this.#unread.get(task) ?? [];
    this.#unread.delete(task);
    return unread;
  }
}
