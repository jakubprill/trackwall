import { z } from "zod";

/**
 * Review comments (ADR-62): what the user writes on lines of a task's changes in the "Changes" tab and sends to the
 * task's session as one review. The daemon queues them per task and types a fixed prompt into the session's terminal
 * once it waits for input; the agent reads the comments with the MCP tool `get_review_comments`. So the text the user
 * wrote reaches the agent as data from a tool, never as keystrokes that the Copilot CLI input box could misread
 * (`@` opens the file picker, a line break submits).
 */

/**
 * The sizes keep a whole review of ASCII text inside the daemon's 64 KiB request body. One comment fits a few
 * paragraphs; a longer note is a new task rather than a review.
 */
export const REVIEW_COMMENT_MAX = 2000;
/** Comments in one review: more lines than this is a rewrite, not a review. */
export const REVIEW_COMMENTS_MAX = 15;
/** The commented line's text kept with the comment, so that the agent finds the line after the file has changed. */
export const REVIEW_LINE_CODE_MAX = 300;
/**
 * Unread comments of one task, over several reviews: a review beyond it is refused, so `get_review_comments` stays a
 * size an agent's context takes.
 */
export const REVIEW_UNREAD_MAX = 60;

/**
 * Which file a comment's line number counts in: `new` for an added or unchanged line, numbered in the worktree's
 * file; `old` for a removed line, numbered in the file at the task's base commit.
 */
export const ReviewSide = z.enum(["new", "old"]);
export type ReviewSide = z.infer<typeof ReviewSide>;

export const ReviewComment = z
  .object({
    /** Relative to the repo root, as in `ChangedFile.path`. */
    path: z.string().min(1).max(1000),
    side: ReviewSide,
    line: z.number().int().positive(),
    /** The line as the diff showed it, without the `+`/`-` marker. */
    code: z.string().max(REVIEW_LINE_CODE_MAX),
    text: z.string().trim().min(1).max(REVIEW_COMMENT_MAX),
  })
  .strict();
export type ReviewComment = z.infer<typeof ReviewComment>;
