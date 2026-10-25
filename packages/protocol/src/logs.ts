import { z } from "zod";
import { TaskId } from "./agents.ts";
import type { Endpoint } from "./api.ts";
import { MiseTaskName } from "./mise.ts";
import { RepoId } from "./workspace.ts";

/**
 * Contract of the `logs` module (§4.2, ADR-28): records of process output with a global `seq` number, read from a cursor.
 * Every action is `POST /api/logs/<action>`. A record is already masked and without ANSI sequences.
 */

/** How many records the daemon keeps in memory per source; older ones are only in the JSONL file. */
export const LOG_BUFFER_RECORDS = 2000;
/** The most records in one `tail` response. */
export const LOG_TAIL_MAX = 1000;

/**
 * Where a record comes from: a repo's mise task run in the repo root, a mise task run in a task's worktree (ADR-59)
 * and a repo's `mise install` from the Batch command. Services, sessions and the daemon will come as further kinds.
 */
export const LogSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("mise-task"), repo: RepoId, miseTask: MiseTaskName }).strict(),
  z.object({ kind: z.literal("task-mise-task"), repo: RepoId, task: TaskId, miseTask: MiseTaskName }).strict(),
  z.object({ kind: z.literal("mise-install"), repo: RepoId }).strict(),
]);
export type LogSource = z.infer<typeof LogSource>;

/** The log source of a mise task run in a repo root (`task: null`) or in a task's worktree (ADR-59). */
export function miseTaskLogSource(repo: RepoId, task: TaskId | null, miseTask: MiseTaskName): LogSource {
  return task === null ? { kind: "mise-task", repo, miseTask } : { kind: "task-mise-task", repo, task, miseTask };
}

export const LogLevel = z.enum(["trace", "debug", "info", "warn", "error"]);
export type LogLevel = z.infer<typeof LogLevel>;

export const LogStream = z.enum(["stdout", "stderr"]);
export type LogStream = z.infer<typeof LogStream>;

export const LogRecord = z.object({
  /**
   * The global record number, rising across all sources. Every daemon run starts from its start time in milliseconds
   * times 1000, so the numbers of successive runs do not repeat (§4.2).
   */
  seq: z.number().int().positive(),
  /** ISO 8601, when the daemon received the line. */
  ts: z.string(),
  /** The run (`RunState.runId`) the line comes from; a source has records of many runs. */
  runId: z.string(),
  stream: LogStream,
  /** From the line's text (the words `ERROR`, `WARN`…), not from the stream: many tools write ordinary progress to stderr. */
  level: LogLevel,
  msg: z.string(),
});
export type LogRecord = z.infer<typeof LogRecord>;

export const LogTail = z.object({
  /** From oldest to newest. */
  records: z.array(LogRecord),
  /** Cursor for the next request (`sinceSeq`). */
  nextSeq: z.number().int().nonnegative(),
  /**
   * Some records after the cursor are lost: they fell out of the buffer, or the cursor comes from another daemon run (then
   * the response is the latest records, as without a cursor). The client then starts from what it got instead of appending.
   */
  dropped: z.boolean(),
});
export type LogTail = z.infer<typeof LogTail>;

export const LogTailRequest = z
  .object({
    source: LogSource,
    /** Records with `seq` greater than the cursor, oldest first; without a cursor the last `limit` records of the source. */
    sinceSeq: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(LOG_TAIL_MAX),
  })
  .strict();
export type LogTailRequest = z.infer<typeof LogTailRequest>;

/** The most errors in one `get_errors` response. */
export const LOG_ERRORS_MAX = 100;
/** The most lines of one error in a response; `omittedLines` counts the rest. */
export const LOG_ERROR_LINES = 60;

/** The lowest level at which a record starts an error: errors only, or warnings too. */
export const LogErrorLevel = z.enum(["warn", "error"]);
export type LogErrorLevel = z.infer<typeof LogErrorLevel>;

/**
 * An error from a log (§4.2, ADR-42): a record at `warn`/`error` level or an exception header together with the lines
 * that belong to it (Java and Node stack traces, `Caused by:`, the Spring "APPLICATION FAILED TO START" report, the
 * Gradle report, indented compiler lines). The same errors of one source (the same first line and exception once
 * numbers are replaced) are one entry with a count; the lines and `seq` come from the latest occurrence.
 */
export const LogError = z.object({
  source: LogSource,
  runId: z.string(),
  stream: LogStream,
  level: LogErrorLevel,
  /** The cause: the last `Caused by:` or the first exception header (`java.net.ConnectException: Connection refused`); `null` without one. */
  exception: z.string().nullable(),
  /** Lines of the latest occurrence; each stack trace keeps its first frames and a line `… N frames omitted` replaces the rest. */
  lines: z.array(z.string()),
  /** How many lines of the error are not in `lines` (beyond `LOG_ERROR_LINES` or omitted frames). */
  omittedLines: z.number().int().nonnegative(),
  /** `seq` of the first record of the latest occurrence. */
  seq: z.number().int().positive(),
  /** ISO 8601, the latest occurrence. */
  ts: z.string(),
  /** ISO 8601, the first occurrence among the records read. */
  firstTs: z.string(),
  count: z.number().int().positive(),
});
export type LogError = z.infer<typeof LogError>;

export const LogErrors = z.object({
  /** Most recent first. */
  errors: z.array(LogError),
  /** There were more errors than `limit`; the most recent ones are kept. */
  truncated: z.boolean(),
  /** Cursor for the next request (`sinceSeq`): the last `seq` of all sources. */
  nextSeq: z.number().int().nonnegative(),
  /** As in `LogTail`: some records after the cursor were evicted from the buffer, or the cursor is from another daemon run. */
  dropped: z.boolean(),
});
export type LogErrors = z.infer<typeof LogErrors>;

export const LogErrorsRequest = z
  .object({
    /** Only the sources of this repo; all of them without it. */
    repo: RepoId.optional(),
    /** Only the sources of this task's worktree (ADR-59); with `null`, none of a task's worktree; all of them without it. */
    task: TaskId.nullable().optional(),
    /** Only the log of this mise task (in every repo or in `repo`, in repo roots and worktrees); without it `mise install` too. */
    miseTask: MiseTaskName.optional(),
    minLevel: LogErrorLevel,
    /** Only errors whose first record has a `seq` greater than the cursor. */
    sinceSeq: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(LOG_ERRORS_MAX),
  })
  .strict();
export type LogErrorsRequest = z.infer<typeof LogErrorsRequest>;

function endpoint<Req extends z.ZodType, Data extends z.ZodType>(action: string, request: Req, data: Data): Endpoint<Req, Data> {
  return { path: `/api/logs/${action}`, request, data };
}

export const logsApi = {
  tail: endpoint("tail", LogTailRequest, LogTail),
};
