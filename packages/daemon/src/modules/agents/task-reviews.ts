import type { ReviewComment } from "@trackwall/protocol";

/**
 * Review comments the user sent on a task's changes and its agent has not read yet (ADR-62), per task, oldest first.
 * Only in daemon memory, like task proposals: a daemon restart drops the unread ones, and the user sends them again.
 */
export class TaskReviews {
  readonly #unread = new Map<string, ReviewComment[]>();

  /** Adds a review after the unread comments; returns how many are unread now. */
  add(task: string, comments: readonly ReviewComment[]): number {
    const unread = [...(this.#unread.get(task) ?? []), ...comments];
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

  /** The task has ended. */
  forget(task: string): void {
    this.#unread.delete(task);
  }
}
