import { PipelineFix, REVIEW_UNREAD_MAX, ReviewComment, TaskId } from "@trackwall/protocol";
import { z } from "zod";
import { DomainError } from "../../infra/errors.ts";

/**
 * Review comments the user sent on a task's changes and its agent has not read yet (ADR-62), per task, oldest first,
 * and the user's latest pipeline fix (ADR-195), which `get_review_comments` returns with them.
 * Since ADR-115 they outlive a daemon restart in `agent-queues.json` (`stored`, `restore`), so the resumed task session
 * reads them; every change is reported to `changed`, which writes the file. A comment counts as read once `take`
 * returns it, also when the agent's call is cancelled before the result reaches it.
 */

/** What `agent-queues.json` keeps of the reviews: the unread comments of each task, and its unread pipeline fix. */
export const StoredReviews = z.array(
  z.object({
    task: TaskId,
    comments: z.array(ReviewComment).max(REVIEW_UNREAD_MAX),
    // A file from before ADR-195 has none.
    pipelineFix: PipelineFix.nullable().default(null),
  }),
);
export type StoredReviews = z.infer<typeof StoredReviews>;

/** What the agent reads with `get_review_comments`. */
export interface UnreadReview {
  comments: ReviewComment[];
  pipelineFix: PipelineFix | null;
}

export class TaskReviews {
  readonly #unread = new Map<string, ReviewComment[]>();
  readonly #pipelineFixes = new Map<string, PipelineFix>();
  readonly #changed: () => void;

  constructor(changed: () => void) {
    this.#changed = changed;
  }

  stored(): StoredReviews {
    const tasks = new Set([...this.#unread.keys(), ...this.#pipelineFixes.keys()]);
    return [...tasks].map((task) => ({
      task,
      comments: this.#unread.get(task) ?? [],
      pipelineFix: this.#pipelineFixes.get(task) ?? null,
    }));
  }

  /** The unread comments the previous daemon kept, of the tasks that are still there (`hasTask`). */
  restore(stored: StoredReviews, hasTask: (task: string) => boolean): void {
    this.#unread.clear();
    this.#pipelineFixes.clear();
    for (const { task, comments, pipelineFix } of stored) {
      if (!hasTask(task)) continue;
      if (comments.length > 0) this.#unread.set(task, comments);
      if (pipelineFix) this.#pipelineFixes.set(task, pipelineFix);
    }
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

  /** The user's request to fix the failed pipeline; it replaces an unread one, whose logs are older. */
  fixPipeline(task: string, fix: PipelineFix): void {
    this.#pipelineFixes.set(task, fix);
    this.#changed();
  }

  unread(task: string): number {
    return this.#unread.get(task)?.length ?? 0;
  }

  pipelineFixUnread(task: string): boolean {
    return this.#pipelineFixes.has(task);
  }

  /** The unread comments and pipeline fix, which from now on count as read. */
  take(task: string): UnreadReview {
    const comments = this.#unread.get(task) ?? [];
    const pipelineFix = this.#pipelineFixes.get(task) ?? null;
    if (comments.length === 0 && pipelineFix === null) return { comments, pipelineFix };
    this.#unread.delete(task);
    this.#pipelineFixes.delete(task);
    this.#changed();
    return { comments, pipelineFix };
  }
}
