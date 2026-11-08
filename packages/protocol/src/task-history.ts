import { z } from "zod";
import { TaskId } from "./agents.ts";
import { BoardItemId } from "./board.ts";
import { CopilotUsage, ModelCalls } from "./copilot-usage.ts";
import { VerificationState } from "./verification.ts";
import { CommitHash, RepoId } from "./workspace.ts";

/**
 * The task journal (§4.19, ADR-150): when the user ends a task, the daemon keeps a record of what it was and what it
 * left, from its own task list and git, never from an agent's text alone: the task's prompt and last summary, the
 * commits and files on its branch, the last verdict. `search_task_history` finds records by words, so a session can
 * learn how a similar change was done before, in this repo or another one.
 */

/** Most commits kept per record (the newest); `commitsTotal` counts all of them. */
export const TASK_HISTORY_MAX_COMMITS = 30;
/** Most changed files kept per record. */
export const TASK_HISTORY_MAX_FILES = 100;
/** A prompt longer than this is cut in the record. */
export const TASK_HISTORY_PROMPT_MAX_CHARS = 2000;
/** A summary longer than this is cut in the record. */
export const TASK_HISTORY_SUMMARY_MAX_CHARS = 4000;
/** Most records in one result. */
export const TASK_HISTORY_MAX_RESULTS = 50;
/** Most characters of prompts, summaries, subjects and paths in one result; it goes to the agent twice. */
export const TASK_HISTORY_MAX_CHARS = 100_000;

export const EndedTaskCommit = z.object({
  hash: CommitHash,
  subject: z.string(),
});
export type EndedTaskCommit = z.infer<typeof EndedTaskCommit>;

/** One ended task in the journal. */
export const EndedTask = z.object({
  task: TaskId,
  repo: RepoId,
  /** The title from the task proposal; `null` for a task the user typed. */
  title: z.string().nullable(),
  /** Cut to `TASK_HISTORY_PROMPT_MAX_CHARS`. */
  prompt: z.string(),
  branch: z.string(),
  baseBranch: z.string().nullable(),
  base: CommitHash,
  /** The commit the task's worktree was at when it ended; `null` when git could not read it. */
  head: CommitHash.nullable(),
  /** The user kept the branch when ending the task, so `head` can still be read in the repo. */
  branchKept: z.boolean(),
  /** ISO 8601. */
  createdAt: z.string(),
  /** ISO 8601. */
  endedAt: z.string(),
  /** A task the supervisor or a session proposed, not one the user typed. */
  proposed: z.boolean(),
  /** The board item the task worked on (ADR-133). */
  item: BoardItemId.nullable(),
  /** The task that handed this one its work (ADR-143). */
  handoffFrom: TaskId.nullable(),
  /**
   * The task this one retried on another model (ADR-232), so a comparison of models can pair the two attempts; `null`
   * for a first attempt and in records written before ADR-232.
   */
  retryOf: TaskId.nullable().default(null),
  /** The task session's last `report_result`, cut to `TASK_HISTORY_SUMMARY_MAX_CHARS`; `null` when it reported none. */
  summary: z.string().nullable(),
  /** The newest commits from the base to `head`, newest first. */
  commits: z.array(EndedTaskCommit),
  /** All commits from the base to `head`; `null` when git could not count them. */
  commitsTotal: z.number().int().nonnegative().nullable(),
  /** The files that differ between the base and `head`. */
  files: z.array(z.string()),
  filesTruncated: z.boolean(),
  /** The last verification's state and when it finished; `null` when the task was never verified. */
  verification: z.object({ state: VerificationState, finishedAt: z.string().nullable() }).nullable(),
  /**
   * The model Trackwall ran the task's sessions on when it ended (ADR-98, ADR-206); `null` for Copilot CLI's default.
   * The default fills records written before ADR-228, as do those of `usage` and `models`.
   */
  model: z.string().nullable().default(null),
  /**
   * What the task's conversation used over its whole life (ADR-228), from Copilot CLI's event log; `null` when the log
   * had no model call or could not be read.
   */
  usage: CopilotUsage.nullable().default(null),
  /**
   * The models Copilot CLI actually ran the conversation on (ADR-225, ADR-228), with their own calls, the most first:
   * a model Copilot CLI took instead of `model`, or several after `/model` or a restart on another one. Empty when the
   * log names none.
   */
  models: z.array(ModelCalls).default([]),
});
export type EndedTask = z.infer<typeof EndedTask>;

/** What `search_task_history` looks for. */
export const TaskHistoryQuery = z.object({
  /**
   * Words that must all appear, in any case, in a record's title, prompt, summary, branch, repo, commit subjects or
   * files; an empty text matches every record.
   */
  text: z.string().max(500),
  /** Only records of these repos; empty for all. */
  repos: z.array(RepoId).max(200),
  /** Only tasks ended on this day or later (`YYYY-MM-DD`, UTC). */
  since: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "since: a date as YYYY-MM-DD")
    .refine(
      (d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d),
      "since: no such day",
    )
    .optional(),
  limit: z.number().int().min(1).max(TASK_HISTORY_MAX_RESULTS),
});
export type TaskHistoryQuery = z.infer<typeof TaskHistoryQuery>;

export const TaskHistoryResult = z.object({
  /** Newest ended first. */
  tasks: z.array(EndedTask),
  /** More records matched than the limit or `TASK_HISTORY_MAX_CHARS` let in; narrow the query. */
  truncated: z.boolean(),
});
export type TaskHistoryResult = z.infer<typeof TaskHistoryResult>;
