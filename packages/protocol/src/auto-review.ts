import { z } from "zod";
import { TaskId, visibleText } from "./agents.ts";
import { apiEndpoints } from "./api.ts";
import { REVIEW_COMMENT_MAX } from "./review.ts";
import { RepoId } from "./workspace.ts";

/**
 * Contract of a task's automatic review (§4.4, ADR-182): Copilot CLI's built-in `/review` on the task's changes, run by
 * the daemon in a short read-only session over ACP (no shell, no file changes, no MCP servers), whose findings the user
 * turns into review comments (ADR-62) in the task's "Changes" tab. Nothing reaches the task's agent until the user sends
 * it. It costs model credits, so it runs when the user asks or, with `autoReview.afterReport` in `workspace.yaml`, once
 * the task's agent reports its result. Each action is `POST /api/auto-review/<action>`.
 */

/** Most findings a review keeps; a review with more is a rewrite, and the rest is in `text`. */
export const AUTO_REVIEW_FINDINGS_MAX = 20;
/** The reviewer's whole answer is kept up to this many characters, for findings it wrote in another shape. */
export const AUTO_REVIEW_TEXT_MAX = 20_000;
/** A finding's title, cut to this many characters. */
export const AUTO_REVIEW_TITLE_MAX = 200;

/**
 * `running` until the reviewer's turn ends; `done` with its findings (none when it found nothing worth a comment);
 * `failed` with the reason in `message`; `cancelled` when the user stopped it or Trackwall stopped during the run.
 */
export const AutoReviewState = z.enum(["running", "done", "failed", "cancelled"]);
export type AutoReviewState = z.infer<typeof AutoReviewState>;

/**
 * What the reviewer checks (ADR-234): `code` is Copilot CLI's `/review` (bugs and security); `rules` checks the change
 * against the repo's own rules for agents (`AGENTS.md`, `CLAUDE.md`, Copilot's instruction files) and its decision records,
 * as they were at the task's base commit. Each kind has its own last review per task.
 */
export const AutoReviewKind = z.enum(["code", "rules"]);
export type AutoReviewKind = z.infer<typeof AutoReviewKind>;

/** Who started it: the user's click, or the task's `report_result` with `autoReview.afterReport` on. */
export const AutoReviewTrigger = z.enum(["user", "report"]);
export type AutoReviewTrigger = z.infer<typeof AutoReviewTrigger>;

/** How bad the reviewer says a finding is, in the words of Copilot CLI's review agent. */
export const AutoReviewSeverity = z.enum(["critical", "high", "medium", "low"]);
export type AutoReviewSeverity = z.infer<typeof AutoReviewSeverity>;

/**
 * One issue the reviewer reported, read from its answer. Model text that a person reads before it may reach the task's
 * agent, so without invisible characters (`visibleText`).
 */
export const AutoReviewFinding = z.object({
  title: visibleText(z.string().min(1).max(AUTO_REVIEW_TITLE_MAX)),
  severity: AutoReviewSeverity.nullable(),
  /** Relative to the worktree root with `/`, as in `ChangedFile.path`; `null` when the reviewer named no file in it. */
  path: z.string().min(1).max(1000).nullable(),
  /** The line in the worktree's file the reviewer named; `null` without one. */
  line: z.number().int().positive().nullable(),
  /** The problem and the suggested fix, ready to be a review comment's text. */
  text: visibleText(z.string().min(1).max(REVIEW_COMMENT_MAX)),
});
export type AutoReviewFinding = z.infer<typeof AutoReviewFinding>;

export const AutoReview = z.object({
  task: TaskId,
  repo: RepoId,
  /** `code` for a review kept before ADR-234, which had only that kind. */
  kind: AutoReviewKind.default("code"),
  state: AutoReviewState,
  trigger: AutoReviewTrigger,
  /** ISO 8601. */
  startedAt: z.string(),
  /** ISO 8601; `null` while running, and on one cancelled because Trackwall crashed during the run (a stop gives its time). */
  finishedAt: z.string().nullable(),
  /** SHA-256 of the diff the reviewer got: an automatic review of the same changes is not run again. */
  diffHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** The diff was cut at `AUTO_REVIEW_DIFF_MAX_BYTES`, so the files after the cut were not reviewed. */
  diffTruncated: z.boolean(),
  findings: z.array(AutoReviewFinding).max(AUTO_REVIEW_FINDINGS_MAX),
  /** The reviewer's answer as it wrote it, cut at `AUTO_REVIEW_TEXT_MAX`; empty while running. */
  text: visibleText(z.string().max(AUTO_REVIEW_TEXT_MAX)),
  /** Why it failed or was cancelled, or on a finished one what the reviewer asked for and was refused; `null` otherwise. */
  message: z.string().nullable(),
  /** The rule files a `rules` review got, relative to the repo root with `/`; empty for `code`. */
  ruleFiles: z.array(z.string()).default([]),
});
export type AutoReview = z.infer<typeof AutoReview>;

/**
 * A task's last finished review of a kind, and whether the task's diff has moved on from the one it saw (ADR-238), as
 * the draft of a merge request names it.
 */
export const FreshAutoReview = z.object({ review: AutoReview, outdated: z.boolean() });
export type FreshAutoReview = z.infer<typeof FreshAutoReview>;

/** The largest diff the reviewer gets: a bigger change is cut after its last whole line within it, and says so. */
export const AUTO_REVIEW_DIFF_MAX_BYTES = 512 * 1024;

/** `kind` is `code` when left out, as before ADR-234. */
const TaskRequest = z.object({ task: TaskId, kind: AutoReviewKind.default("code") }).strict();

const endpoint = apiEndpoints("auto-review");

export const autoReviewApi = {
  /**
   * Starts a review of the task's changes in the background and returns it (`running`); while one of the kind runs, that one.
   * `bad_request` when the task has no changes, or for `rules` when the repo has no rule files; `agent_unavailable`
   * without Copilot CLI.
   */
  start: endpoint("start", TaskRequest, AutoReview),
  /** The task's last review of the kind, also from before a daemon restart; `null` when there was none. */
  get: endpoint("get", TaskRequest, AutoReview.nullable()),
  /** Stops the running review; it ends `cancelled`. A finished one is returned as it is. */
  cancel: endpoint("cancel", TaskRequest, AutoReview.nullable()),
};
