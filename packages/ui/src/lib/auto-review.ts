import { type AutoReview, type AutoReviewFinding, countLabel, REVIEW_COMMENT_MAX, type ReviewComment } from "@trackwall/protocol";
import { diffLines } from "./diff-lines.ts";
import type { StatusTone } from "./repo-status.ts";
import { lineComment, type ReviewDraft } from "./review-drafts.ts";

/**
 * How a task's automatic review (ADR-182) shows in its "Changes" tab, and how a finding becomes a review comment
 * (ADR-62) on a line of the diff the tab shows. No React here, so the rules are tested on their own.
 */

/** A running review is polled more often, so the findings show soon after the reviewer ends. */
export function autoReviewPollMs(review: AutoReview | null | undefined): number {
  return review?.state === "running" ? 2000 : 10_000;
}

/** The state next to the section's title. */
export function autoReviewLabel(review: AutoReview): { tone?: StatusTone; label: string } {
  switch (review.state) {
    case "running":
      return { tone: "warning", label: "reviewing" };
    case "done":
      return review.findings.length === 0
        ? { tone: "ok", label: "no findings" }
        : { tone: "warning", label: countLabel(review.findings.length, { one: "finding", other: "findings" }) };
    case "failed":
      return { tone: "error", label: "failed" };
    case "cancelled":
      return { label: "cancelled" };
  }
}

/**
 * The review comment a finding becomes: on the line the reviewer named, when the diff shows that line of the worktree's
 * file (an added or unchanged line), with the finding's title over its text. `null` when the finding names no line, or
 * one the diff does not show, since a comment only stands on a line the user can see.
 */
export function findingComment(finding: AutoReviewFinding, patch: string): ReviewComment | null {
  if (finding.path === null || finding.line === null) return null;
  const { lines } = diffLines(patch, Number.POSITIVE_INFINITY);
  const shown = lines.find(({ anchor }) => anchor?.side === "new" && anchor.path === finding.path && anchor.line === finding.line);
  if (!shown?.anchor) return null;
  const text = `${finding.title}\n\n${finding.text}`;
  return lineComment(shown.anchor, shown.text, text.length > REVIEW_COMMENT_MAX ? `${text.slice(0, REVIEW_COMMENT_MAX - 1)}…` : text);
}

/** Whether the comment is among the drafts already, so a finding is added once. */
export function inDrafts(comment: ReviewComment, drafts: readonly ReviewDraft[]): boolean {
  return drafts.some(
    ({ comment: draft }) =>
      draft.path === comment.path && draft.side === comment.side && draft.line === comment.line && draft.text === comment.text,
  );
}
