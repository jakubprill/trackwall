import { z } from "zod";
import { TaskId } from "./agents.ts";
import { apiEndpoints, Done } from "./api.ts";
import { RepoHostKind } from "./repo-hosts.ts";
import { WebAddress } from "./workspace.ts";

/**
 * Contract of the `merge-requests` module (§4.12, ADR-77): a finished task on its way to a merge request. The daemon
 * pushes the task branch when the user asks, opens the repo host's new merge request form filled in with what the user
 * approved, and reads the merge request of the task branch and its pipeline back for the task panel. It creates nothing
 * on the repo host itself: the user creates the merge request in the host's own form. Each action is
 * `POST /api/merge-requests/<action>`.
 */

/** GitLab's limit on a merge request title; GitHub's is higher. */
export const MERGE_REQUEST_TITLE_MAX = 255;
/** The most of a description the form gets; the address of the form carries it, and servers refuse long addresses. */
export const MERGE_REQUEST_DESCRIPTION_MAX = 4000;

/** `open` also for a GitLab merge request that is locked while it merges. */
export const MergeRequestState = z.enum(["open", "merged", "closed"]);
export type MergeRequestState = z.infer<typeof MergeRequestState>;

/**
 * The pipeline of the merge request's last commit, summed up across GitLab's pipeline or GitHub's checks and statuses:
 * `pending` before anything runs, `manual` when it waits for someone to start a job.
 */
export const PipelineState = z.enum(["pending", "running", "passed", "failed", "cancelled", "skipped", "manual"]);
export type PipelineState = z.infer<typeof PipelineState>;

/** Most failed jobs a pipeline names; the pipeline's page has the rest. */
export const PIPELINE_FAILED_JOBS_MAX = 10;

/**
 * A job of a failed pipeline that failed it: a GitLab job (not one allowed to fail) or a GitHub check or commit
 * status. Its log stays on the repo host: an agent reads it with the user's own MCP server for the host (ADR-154).
 */
export const FailedJob = z.object({
  name: z.string(),
  /** The job's page on the repo host; `null` for a commit status that gave none. */
  url: z.string().nullable(),
});
export type FailedJob = z.infer<typeof FailedJob>;

export const Pipeline = z.object({
  state: PipelineState,
  /** The pipeline (GitLab) or the checks of the pull request (GitHub) on the repo host. */
  url: z.string(),
  /** The commit it ran on: a new pipeline on a later commit that fails again is a new failure (ADR-154). */
  commit: z.string(),
  /** While `failed`, the jobs that failed it, at most `PIPELINE_FAILED_JOBS_MAX`; empty otherwise. */
  failedJobs: z.array(FailedJob),
});
export type Pipeline = z.infer<typeof Pipeline>;

/** The merge request whose source branch is the task branch, the most recently updated one when there were several. */
export const MergeRequest = z.object({
  /** `!12` on GitLab, `#12` on GitHub. */
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  state: MergeRequestState,
  /** `null` when nothing has run on its last commit. */
  pipeline: Pipeline.nullable(),
});
export type MergeRequest = z.infer<typeof MergeRequest>;

/** The repo's main remote as a project on a repo host: GitHub at `github.com` or a repo host from the settings. */
export const HostedProject = z.object({
  kind: RepoHostKind,
  host: z.string(),
  /** `owner/repo` on GitHub, `group/subgroup/project` on GitLab. */
  path: z.string(),
});
export type HostedProject = z.infer<typeof HostedProject>;

/**
 * The task branch against the main remote, as the last push or fetch left it: Trackwall does not ask the server on
 * every read, so a push by someone else shows only after the next sync or push.
 */
export const BranchOnRemote = z.object({
  /** The main remote's name (`origin`). */
  remote: z.string(),
  /** The remote has the task branch. */
  published: z.boolean(),
  /** Commits of the task branch the remote's branch does not have; all of them before the first push. */
  unpushed: z.number().int().nonnegative(),
  /** Commits of the remote's branch the task branch does not have: a push would be refused until they are merged in. */
  behind: z.number().int().nonnegative(),
});
export type BranchOnRemote = z.infer<typeof BranchOnRemote>;

export const TaskBranchPush = BranchOnRemote.extend({
  /** Commits on the task branch since the task's base. */
  commits: z.number().int().nonnegative(),
  /** Files changed in the worktree and not committed: they are not part of a push. */
  uncommitted: z.number().int().nonnegative(),
});
export type TaskBranchPush = z.infer<typeof TaskBranchPush>;

export const MergeRequestLookup = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("found"), mergeRequest: MergeRequest }),
  /** The repo host has no merge request from the task branch. */
  z.object({ kind: z.literal("none") }),
  /** `gh` or `glab` did not answer (missing, not signed in, no network); `message` says why. */
  z.object({ kind: z.literal("unavailable"), message: z.string() }),
]);
export type MergeRequestLookup = z.infer<typeof MergeRequestLookup>;

export const TaskMergeRequest = z.object({
  task: TaskId,
  /** `null` when the repo has no main remote (neither `origin` nor a single other one). */
  push: TaskBranchPush.nullable(),
  /** `null` when the main remote is not on GitHub or a repo host from the settings. */
  project: HostedProject.nullable(),
  /** `null` while `project` is, or before the task branch was ever published. */
  lookup: MergeRequestLookup.nullable(),
  /** The branch the merge request goes into: the task's base branch, or the remote's default when it has none. */
  targetBranch: z.string().nullable(),
});
export type TaskMergeRequest = z.infer<typeof TaskMergeRequest>;

/**
 * A task's merge request as the daemon last read it while following it in the background (ADR-154), with the project
 * it is in, so its number is written as the repo host writes it.
 */
export const FollowedMergeRequest = MergeRequest.extend({
  project: HostedProject,
  /**
   * ISO 8601, when the daemon saw its pipeline fail, having seen it in another state or on another commit before;
   * `null` otherwise. A pipeline already failed when the daemon first read it has none, so a restart does not announce
   * old failures again. A new value is what the desktop shell and a browser tab notify about.
   */
  pipelineFailedAt: z.string().nullable(),
});
export type FollowedMergeRequest = z.infer<typeof FollowedMergeRequest>;

const TaskRequest = z.object({ task: TaskId }).strict();

/** What the user approved for the repo host's form; the form is where they change the rest. */
export const MergeRequestDraft = z
  .object({
    task: TaskId,
    title: z.string().trim().min(1).max(MERGE_REQUEST_TITLE_MAX),
    description: z.string().max(MERGE_REQUEST_DESCRIPTION_MAX),
  })
  .strict();
export type MergeRequestDraft = z.infer<typeof MergeRequestDraft>;

/** What the repo host's new merge request form is filled in with; `target: null` lets the repo host pick its default branch. */
export interface MergeRequestForm {
  source: string;
  target: string | null;
  title: string;
  description: string;
}

const endpoint = apiEndpoints("merge-requests");

export const mergeRequestsApi = {
  /** The task branch against the main remote and the merge request from it; the repo host's answer is reused for a few seconds. */
  get: endpoint("get", TaskRequest, TaskMergeRequest),
  /**
   * Pushes the task branch to the main remote, without force and without the repo's hooks, and only where the remote fetches from. `bad_request` when the
   * branch has no commits; a refused push (the remote moved on) is `repo_unavailable` with git's message.
   */
  push: endpoint("push", TaskRequest, TaskMergeRequest),
  /**
   * Opens the repo host's new merge request form in the browser, from the task branch into the target branch, with the
   * title and description filled in. `bad_request` while the branch has unpushed commits or the remote is on no known repo host.
   */
  openForm: endpoint("open-form", MergeRequestDraft, Done),
  /** The address `openForm` opens, with the same refusals, for a page that opens it itself when the daemon has no desktop (ADR-120). */
  formUrl: endpoint("form-url", MergeRequestDraft, z.object({ url: WebAddress })),
};
