import {
  MERGE_REQUEST_THREADS_MAX,
  MergeRequestComments,
  PipelineFix,
  REVIEW_UNREAD_MAX,
  ReviewComment,
  TaskId,
} from "@trackwall/protocol";
import { z } from "zod";
import { DomainError } from "../../infra/errors.ts";

/**
 * Review comments the user sent on a task's changes and its agent has not read yet (ADR-62), per task, oldest first,
 * the user's latest pipeline fix (ADR-197) and the merge request threads the user handed over (ADR-256), which
 * `get_review_comments` returns with them.
 * Since ADR-115 they outlive a daemon restart in `agent-queues.json` (`stored`, `restore`), so the resumed task session
 * reads them; every change is reported to `changed`, which writes the file. A comment counts as read once `take`
 * returns it, also when the agent's call is cancelled before the result reaches it.
 */

/**
 * What `agent-queues.json` keeps of the reviews: the unread comments of each task, its unread pipeline fix and its
 * unread merge request comments.
 */
export const StoredReviews = z.array(
  z.object({
    task: TaskId,
    comments: z.array(ReviewComment).max(REVIEW_UNREAD_MAX),
    // A file from before ADR-197 has none.
    pipelineFix: PipelineFix.nullable().default(null),
    // A file from before ADR-256 has none.
    mergeRequestComments: MergeRequestComments.nullable().default(null),
  }),
);
export type StoredReviews = z.infer<typeof StoredReviews>;

/** What the agent reads with `get_review_comments`. */
export interface UnreadReview {
  comments: ReviewComment[];
  pipelineFix: PipelineFix | null;
  mergeRequestComments: MergeRequestComments | null;
}

export class TaskReviews {
  /** What waits unread per task; a task with nothing unread has no entry. */
  readonly #unread = new Map<string, UnreadReview>();
  readonly #changed: () => void;

  constructor(changed: () => void) {
    this.#changed = changed;
  }

  stored(): StoredReviews {
    return [...this.#unread].map(([task, review]) => ({ task, ...review }));
  }

  /** The unread comments the previous daemon kept, of the tasks that are still there (`hasTask`). */
  restore(stored: StoredReviews, hasTask: (task: string) => boolean): void {
    this.#unread.clear();
    for (const { task, ...review } of stored) if (hasTask(task) && !isEmpty(review)) this.#unread.set(task, review);
  }

  /** Adds a review after the unread comments; returns how many are unread now. More than `REVIEW_UNREAD_MAX` is refused. */
  add(task: string, comments: readonly ReviewComment[]): number {
    const unread = [...this.#of(task).comments, ...comments];
    if (unread.length > REVIEW_UNREAD_MAX)
      throw new DomainError(
        "bad_request",
        `the agent has not read ${unread.length - comments.length} comments yet; at most ${REVIEW_UNREAD_MAX} can wait for it`,
      );
    this.#update(task, { comments: unread });
    return unread.length;
  }

  /** The user's request to fix the failed pipeline; it replaces an unread one, whose logs are older. */
  fixPipeline(task: string, fix: PipelineFix): void {
    this.#update(task, { pipelineFix: fix });
  }

  /**
   * Merge request threads the user handed over (ADR-256), joined with the unread ones by thread: a thread sent again
   * replaces its older copy, and a merge request other than the one before (the branch got a new one) starts afresh.
   * More than `MERGE_REQUEST_THREADS_MAX` unread is refused.
   */
  addThreads(task: string, comments: MergeRequestComments): void {
    const before = this.#of(task).mergeRequestComments;
    const kept = before?.mergeRequest === comments.mergeRequest ? before.threads : [];
    const sent = new Set(comments.threads.map((t) => t.id));
    const threads = [...kept.filter((t) => !sent.has(t.id)), ...comments.threads];
    if (threads.length > MERGE_REQUEST_THREADS_MAX)
      throw new DomainError(
        "bad_request",
        `the agent has not read ${kept.length} merge request threads yet; at most ${MERGE_REQUEST_THREADS_MAX} can wait for it`,
      );
    this.#update(task, { mergeRequestComments: { mergeRequest: comments.mergeRequest, threads } });
  }

  unread(task: string): number {
    return this.#of(task).comments.length;
  }

  pipelineFixUnread(task: string): boolean {
    return this.#of(task).pipelineFix !== null;
  }

  threadsUnread(task: string): boolean {
    return this.#of(task).mergeRequestComments !== null;
  }

  /** Everything unread, which from now on counts as read. */
  take(task: string): UnreadReview {
    const review = this.#of(task);
    if (this.#unread.delete(task)) this.#changed();
    return review;
  }

  #of(task: string): UnreadReview {
    return this.#unread.get(task) ?? { comments: [], pipelineFix: null, mergeRequestComments: null };
  }

  #update(task: string, change: Partial<UnreadReview>): void {
    this.#unread.set(task, { ...this.#of(task), ...change });
    this.#changed();
  }
}

function isEmpty(review: UnreadReview): boolean {
  return review.comments.length === 0 && review.pipelineFix === null && review.mergeRequestComments === null;
}
