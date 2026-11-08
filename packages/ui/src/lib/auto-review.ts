import {
  type AutoReview,
  type AutoReviewFinding,
  type AutoReviewKind,
  countLabel,
  cutText,
  REVIEW_COMMENT_MAX,
  type ReviewComment,
} from "@trackwall/protocol";
import { DIFF_SHOWN_LINES, type DiffAnchor, diffLines } from "./diff-lines.ts";
import type { StatusTone } from "./repo-status.ts";
import { lineComment, type ReviewDraft } from "./review-drafts.ts";

/**
 * How a task's automatic review (ADR-182) and its check against the repo's rules (ADR-234) show in its "Changes" tab, and how a finding becomes a review comment
 * (ADR-62) on a line of the diff the tab shows. No React here, so the rules are tested on their own.
 */

/** A running review is polled more often, so the findings show soon after the reviewer ends. */
export function autoReviewPollMs(review: AutoReview | null | undefined): number {
  return review?.state === "running" ? 2000 : 10_000;
}

/** The words of a kind's section in the "Changes" tab. */
export const AUTO_REVIEW_TEXTS: Record<
  AutoReviewKind,
  {
    title: string;
    idle: string;
    start: string;
    again: string;
    startTitle: string;
    running: string;
    finding: { one: string; other: string };
  }
> = {
  code: {
    title: "Automatic review",
    idle: "Copilot CLI reads the changes and reports what looks wrong. It costs model credits.",
    start: "Review",
    again: "Review again",
    startTitle: "review the task's changes with Copilot CLI",
    running: "reviewing",
    finding: { one: "finding", other: "findings" },
  },
  rules: {
    title: "Repo rules",
    idle: "Copilot CLI checks the changes against the repo's rules for agents and its ADRs. It costs model credits.",
    start: "Check rules",
    again: "Check again",
    startTitle: "check the task's changes against the repo's rules for agents and its decision records",
    running: "checking",
    finding: { one: "violation", other: "violations" },
  },
};

/** The state next to the section's title. */
export function autoReviewLabel(review: AutoReview): { tone?: StatusTone; label: string } {
  const texts = AUTO_REVIEW_TEXTS[review.kind];
  switch (review.state) {
    case "running":
      return { tone: "warning", label: texts.running };
    case "done":
      return review.findings.length === 0
        ? { tone: "ok", label: `no ${texts.finding.other}` }
        : { tone: "warning", label: countLabel(review.findings.length, texts.finding) };
    case "failed":
      return { tone: "error", label: "failed" };
    case "cancelled":
      return { label: "cancelled" };
  }
}

/** The lines of the worktree's files (added or unchanged) the "Changes" view shows, by file and line number. */
export type ShownLines = ReadonlyMap<string, { anchor: DiffAnchor; text: string }>;

const shownKey = (path: string, line: number) => `${line}:${path}`;

/** The lines of `patch` a finding can stand on: those of the first `maxLines`, as the diff shows them. */
export function shownLines(patch: string, maxLines = DIFF_SHOWN_LINES): ShownLines {
  const shown = new Map<string, { anchor: DiffAnchor; text: string }>();
  for (const { anchor, text } of diffLines(patch, maxLines).lines)
    if (anchor?.side === "new") shown.set(shownKey(anchor.path, anchor.line), { anchor, text });
  return shown;
}

/**
 * The review comment a finding becomes: on the line the reviewer named, when the diff shows that line of the worktree's
 * file (an added or unchanged line), with the finding's title over its text. `null` when the finding names no line, or
 * one the diff does not show, since a comment only stands on a line the user can see.
 */
export function findingComment(finding: AutoReviewFinding, shown: ShownLines): ReviewComment | null {
  if (finding.path === null || finding.line === null) return null;
  const line = shown.get(shownKey(finding.path, finding.line));
  if (line === undefined) return null;
  return lineComment(line.anchor, line.text, cutText(`${finding.title}\n\n${finding.text}`, REVIEW_COMMENT_MAX));
}

/** Whether the comment is among the drafts already, so a finding is added once. */
export function inDrafts(comment: ReviewComment, drafts: readonly ReviewDraft[]): boolean {
  return drafts.some(
    ({ comment: draft }) =>
      draft.path === comment.path && draft.side === comment.side && draft.line === comment.line && draft.text === comment.text,
  );
}
