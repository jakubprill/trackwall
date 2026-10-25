import { type PromptDelivery, REVIEW_LINE_CODE_MAX, type ReviewComment } from "@trackwall/protocol";
import type { DiffAnchor } from "./diff-lines.ts";

/**
 * Review comments the user is writing on a task's changes before sending them to the agent as one review (ADR-62).
 * They live in the task panel's state: switching tabs keeps them, leaving the task drops them.
 */

/** A comment not sent yet; `id` tells two comments on the same line apart. */
export interface ReviewDraft {
  id: number;
  comment: ReviewComment;
}

/** The same line of the same file on the same side: where a comment form opens and which lines are marked. */
export function anchorKey(anchor: DiffAnchor): string {
  return `${anchor.side}:${anchor.line}:${anchor.path}`;
}

/**
 * A comment on a diff line: the line's text without its `+`/`-`/space marker, cut to what the contract keeps, never
 * between the two halves of a character outside the BMP.
 */
export function lineComment(anchor: DiffAnchor, diffText: string, text: string): ReviewComment {
  const code = diffText.slice(1, REVIEW_LINE_CODE_MAX + 1);
  return { ...anchor, code: /[\uD800-\uDBFF]$/.test(code) ? code.slice(0, -1) : code, text: text.trim() };
}

/** What the user is told after sending: when the agent gets the review. */
export function deliveryMessage(delivery: PromptDelivery): string {
  switch (delivery) {
    case "typed":
      return "Sent: the agent is reading your review.";
    case "queued":
      return "Sent: the agent gets your review once it waits for input again.";
    case "on_resume":
      return "Saved: the agent gets your review when you resume the task.";
  }
}
