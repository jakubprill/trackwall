import { z } from "zod";
import { SessionId, TaskId, TaskPrompt } from "./agents.ts";
import type { Endpoint } from "./api.ts";
import { SessionView } from "./conversation.ts";
import { SyncOutcome } from "./sync.ts";
import { TaskState } from "./task-state.ts";
import { Commit, RepoId } from "./workspace.ts";

/**
 * The day start (ADR-70): one action, "Start my day", that syncs every repo, computes the day report and starts a new
 * supervisor whose first message asks it to brief the user from that report. The daemon computes the facts, the
 * supervisor only reads and judges them, so the morning costs one prompt instead of a tool call per repo.
 */

/** How many of a repo's new commits the day report lists, newest first; `total` counts them all. */
export const DAY_REPORT_COMMITS = 5;

/** What happened on a repo's remote default branch since the last day start. */
export const DayReportCommits = z.discriminatedUnion("kind", [
  /** The branch moved forward from the commit of the last day start by `total` commits. */
  z.object({ kind: z.literal("new"), total: z.number().int().positive(), commits: z.array(Commit) }),
  /** The commit of the last day start is no longer in the branch's history (a force push): only its newest commits. */
  z.object({ kind: z.literal("rewritten"), commits: z.array(Commit) }),
  /** The last day start did not know this repo (a new clone, or its default branch was unknown then). */
  z.object({ kind: z.literal("first-seen") }),
]);
export type DayReportCommits = z.infer<typeof DayReportCommits>;

/**
 * A repo with something to say: new commits on its remote default branch, or a sync that did not update it. Repos with
 * neither are only counted (`quietRepos`), so the report stays short with dozens of repos.
 */
export const DayReportRepo = z.object({
  repo: RepoId,
  /** The remote address without scheme, as on the repo list (`Repo.remote`): the project path on the repo host. */
  remote: z.string().nullable(),
  /** The remote default branch, e.g. `origin/main`; `null` when the repo has no remote or the remote names no default branch. */
  remoteBranch: z.string().nullable(),
  /** `null` when nothing is known to compare: no remote default branch, or no earlier day start at all. */
  commits: DayReportCommits.nullable(),
  /** The repo's result in the day start's sync; `null` when the sync did not reach it (a repo being cloned). */
  sync: SyncOutcome.nullable(),
});
export type DayReportRepo = z.infer<typeof DayReportRepo>;

/** An open task (ADR-31) and how far its repo moved on since the task started. */
export const DayReportTask = z.object({
  task: TaskId,
  repo: RepoId,
  /** The proposal's title, or for a task typed in the UI the start of its prompt. */
  title: z.string(),
  branch: z.string(),
  /** The state of the task's newest running session; `null` when none runs (the user resumes it in Sessions). */
  sessionState: TaskState.nullable(),
  /** The task's running session waits for the user (`Session.needsAttention`). */
  needsAttention: z.boolean(),
  /** ISO 8601, when the task's session last reported its summary; `null` before the first. */
  summaryAt: z.string().nullable(),
  /** Commits on the repo's remote default branch that the task's base commit does not have; `null` when unknown. */
  behind: z.number().int().nonnegative().nullable(),
});
export type DayReportTask = z.infer<typeof DayReportTask>;

export const DayReport = z.object({
  /** ISO 8601, when this day start began. */
  startedAt: z.iso.datetime(),
  /** ISO 8601, when the previous day start began; `null` for the first one, which has nothing to compare with. */
  since: z.iso.datetime().nullable(),
  repos: z.array(DayReportRepo),
  /** Repos of the projects folder with nothing new and a sync that brought them up to date. */
  quietRepos: z.number().int().nonnegative(),
  tasks: z.array(DayReportTask),
});
export type DayReport = z.infer<typeof DayReport>;

/** The steps of a day start, in order. */
export const DayStartStep = z.enum(["sync", "report", "supervisor"]);
export type DayStartStep = z.infer<typeof DayStartStep>;

/** A day start in the daemon's memory, like a sync (ADR-21): the step it is in, or the one it ended in. */
export const DayStartRun = z.object({
  /** ISO 8601. */
  startedAt: z.iso.datetime(),
  /** ISO 8601; `null` while it runs. */
  finishedAt: z.iso.datetime().nullable(),
  step: DayStartStep,
  /** Why it stopped before starting the supervisor; `null` while it runs and after a start that succeeded. */
  error: z.string().nullable(),
  /** The supervisor it started; `null` until then. */
  supervisor: SessionId.nullable(),
});
export type DayStartRun = z.infer<typeof DayStartRun>;

/**
 * `dayStart` in `workspace.yaml`, by hand only: `prompt` is added to the day start's first message after Trackwall's own,
 * for what only the user knows (an issue tracker query, a group on the repo host), so it stays out of the repo (ADR-7).
 * As long as a task's prompt, since both go into one `--interactive=` argument.
 */
export const DayStartSettings = z.object({ prompt: TaskPrompt }).strict();
export type DayStartSettings = z.infer<typeof DayStartSettings>;

function endpoint<Req extends z.ZodType, Data extends z.ZodType>(action: string, request: Req, data: Data): Endpoint<Req, Data> {
  return { path: `/api/day-start/${action}`, request, data };
}

export const dayStartApi = {
  /**
   * Starts a day start in the background and returns it at once; a running one is returned instead. `bad_request` while a
   * supervisor runs (the user stops it first, so no conversation is closed without them) or without a projects folder.
   * `view` is how the new supervisor shows (ADR-107).
   */
  start: endpoint("start", z.object({ view: SessionView.default("terminal") }).strict(), DayStartRun),
  /** The last day start since the daemon started; `null` when there was none. */
  run: endpoint("run", z.object({}).strict(), DayStartRun.nullable()),
};
