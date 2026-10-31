import {
  type FailedJob,
  type HostedProject,
  type MergeRequest,
  type MergeRequestForm,
  PIPELINE_FAILED_JOBS_MAX,
  type Pipeline,
  type PipelineState,
  type RepoHostKind,
} from "@trackwall/protocol";
import { z } from "zod";

/**
 * How GitHub and GitLab differ for a task's merge request (ADR-77): the address of the new merge request form with its
 * fields filled in, and the API paths and response fields of the merge request from a source branch and its pipeline
 * with the jobs that failed it (ADR-154).
 * Only reads go through the API; the user creates the merge request in the form. Running `gh` and `glab` is in
 * `hosting.ts`, the rest are pure functions.
 */

/** One `<cli> api` call, its response checked by `schema`. */
type HostApi = <T>(path: string, schema: z.ZodType<T>) => Promise<T>;

/**
 * The longest form address: GitLab behind nginx refuses addresses over 8 KB, and Windows command lines (the browser gets
 * the address as an argument) end at 32 KB. A description in Polish or with emoji grows up to nine times when escaped.
 */
const FORM_URL_MAX = 7000;

interface MergeRequestHostApi {
  formUrl(project: HostedProject, form: MergeRequestForm): string;
  /** The most recently updated merge request from `branch` in any state; `null` when there is none. */
  find(api: HostApi, project: HostedProject, branch: string): Promise<MergeRequest | null>;
}

const Sha = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);

const GitHubPull = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  html_url: z.string(),
  state: z.enum(["open", "closed"]),
  merged_at: z.string().nullable(),
  head: z.object({ sha: Sha }),
});

const GitHubCheckRuns = z.object({
  total_count: z.number().int().nonnegative(),
  check_runs: z.array(
    z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable(), html_url: z.string().nullable() }),
  ),
});
type GitHubCheckRun = z.infer<typeof GitHubCheckRuns>["check_runs"][number];

/** GitHub's largest page of check runs, and how many pages to read: a commit with more checks than that is rare. */
const CHECK_RUNS_PAGE = 100;
const CHECK_RUNS_MAX_PAGES = 5;

const GitHubCombinedStatus = z.object({
  state: z.string(),
  total_count: z.number().int().nonnegative(),
  statuses: z.array(z.object({ context: z.string(), state: z.string(), target_url: z.string().nullable() })),
});

/** A check run that has not completed is `pending` until it runs; a completed one by its conclusion. */
function checkRunState(run: { status: string; conclusion: string | null }): PipelineState {
  if (run.status === "in_progress") return "running";
  if (run.status !== "completed") return "pending";
  switch (run.conclusion) {
    case "success":
    case "neutral":
      return "passed";
    case "skipped":
      return "skipped";
    case "cancelled":
      return "cancelled";
    case "action_required":
      return "manual";
    default:
      // `failure`, `timed_out`, `stale` and anything GitHub adds later: not a pass.
      return "failed";
  }
}

/** GitHub's combined status of the commit statuses other CI systems set; `running` while one has not reported. */
function statusState(state: string): PipelineState {
  if (state === "success") return "passed";
  if (state === "pending") return "running";
  return "failed";
}

/** The states, worst first: one failed check fails the whole, one still running keeps it running. */
const PRECEDENCE: readonly PipelineState[] = ["failed", "running", "pending", "manual", "cancelled", "passed", "skipped"];

/** The checks and statuses of one commit as one state; `null` when nothing ran on it. */
function combinedState(states: readonly PipelineState[]): PipelineState | null {
  return PRECEDENCE.find((state) => states.includes(state)) ?? null;
}

const githubApi: MergeRequestHostApi = {
  formUrl(project, form) {
    const range = form.target === null ? branchPath(form.source) : `${branchPath(form.target)}...${branchPath(form.source)}`;
    const query = new URLSearchParams({ quick_pull: "1", title: form.title, body: form.description });
    return `https://${project.host}/${project.path}/compare/${range}?${query}`;
  },
  async find(api, project, branch) {
    const owner = project.path.split("/")[0] ?? "";
    const head = encodeURIComponent(`${owner}:${branch}`);
    const [pull] = await api(
      `repos/${project.path}/pulls?head=${head}&state=all&sort=updated&direction=desc&per_page=1`,
      z.array(GitHubPull),
    );
    if (!pull) return null;
    const commit = `repos/${project.path}/commits/${pull.head.sha}`;
    const [runs, status] = await Promise.all([checkRuns(api, commit), api(`${commit}/status`, GitHubCombinedStatus)]);
    const states = [...runs.states, ...(status.total_count > 0 ? [statusState(status.state)] : [])];
    const state = combinedState(states);
    const failedJobs = [
      ...runs.failed,
      ...status.statuses.filter((s) => statusState(s.state) === "failed").map((s) => ({ name: s.context, url: s.target_url })),
    ];
    return {
      number: pull.number,
      title: pull.title,
      url: pull.html_url,
      state: pull.merged_at !== null ? "merged" : pull.state,
      pipeline:
        state === null
          ? null
          : { state, url: `${pull.html_url}/checks`, commit: pull.head.sha, failedJobs: state === "failed" ? atMost(failedJobs) : [] },
    };
  },
};

/**
 * The states of every check run of a commit, and the failed ones; a commit with more of them than the pages read gets
 * `pending` for the rest, so an unread failure never shows as a pass.
 */
async function checkRuns(api: HostApi, commit: string): Promise<{ states: PipelineState[]; failed: FailedJob[] }> {
  const runs: GitHubCheckRun[] = [];
  let total = 0;
  for (let page = 1; page <= CHECK_RUNS_MAX_PAGES; page++) {
    const received = await api(`${commit}/check-runs?per_page=${CHECK_RUNS_PAGE}&page=${page}`, GitHubCheckRuns);
    runs.push(...received.check_runs);
    total = received.total_count;
    if (runs.length >= total || received.check_runs.length < CHECK_RUNS_PAGE) break;
  }
  const states = runs.map(checkRunState);
  const failed = runs.filter((run) => checkRunState(run) === "failed").map((run) => ({ name: run.name, url: run.html_url }));
  return { states: runs.length < total ? [...states, "pending"] : states, failed };
}

/** The first failed jobs a pipeline names; its page has the rest. */
function atMost(jobs: FailedJob[]): FailedJob[] {
  return jobs.slice(0, PIPELINE_FAILED_JOBS_MAX);
}

const GitLabMergeRequests = z.array(z.object({ iid: z.number().int().positive() }));

const GitLabMergeRequest = z.object({
  iid: z.number().int().positive(),
  title: z.string(),
  web_url: z.string(),
  state: z.string(),
  head_pipeline: z.object({ id: z.number().int().positive(), sha: Sha, status: z.string(), web_url: z.string() }).nullish(),
});

/** A job of a pipeline; one allowed to fail does not fail the pipeline, so it is not one that failed it. */
const GitLabJobs = z.array(z.object({ name: z.string(), web_url: z.string(), allow_failure: z.boolean() }));

/** GitLab's pipeline statuses; one GitLab adds later counts as `pending` until it is known. */
function gitlabPipelineState(status: string): PipelineState {
  switch (status) {
    case "running":
      return "running";
    case "success":
      return "passed";
    case "failed":
      return "failed";
    case "canceled":
    case "canceling":
      return "cancelled";
    case "skipped":
      return "skipped";
    case "manual":
      return "manual";
    default:
      return "pending";
  }
}

function gitlabState(state: string): MergeRequest["state"] {
  if (state === "merged") return "merged";
  if (state === "closed") return "closed";
  return "open";
}

const gitlabApi: MergeRequestHostApi = {
  formUrl(project, form) {
    const query = new URLSearchParams({ "merge_request[source_branch]": form.source });
    if (form.target !== null) query.set("merge_request[target_branch]", form.target);
    query.set("merge_request[title]", form.title);
    query.set("merge_request[description]", form.description);
    return `https://${project.host}/${project.path}/-/merge_requests/new?${query}`;
  },
  async find(api, project, branch) {
    const base = `projects/${encodeURIComponent(project.path)}/merge_requests`;
    const [found] = await api(
      `${base}?source_branch=${encodeURIComponent(branch)}&state=all&order_by=updated_at&sort=desc&per_page=1`,
      GitLabMergeRequests,
    );
    if (!found) return null;
    // The list leaves out the pipeline; one merge request carries it.
    const mr = await api(`${base}/${found.iid}`, GitLabMergeRequest);
    const head = mr.head_pipeline;
    let pipeline: Pipeline | null = null;
    if (head) {
      const state = gitlabPipelineState(head.status);
      const failedJobs = state === "failed" ? await gitlabFailedJobs(api, project, head.id) : [];
      pipeline = { state, url: head.web_url, commit: head.sha, failedJobs };
    }
    return { number: mr.iid, title: mr.title, url: mr.web_url, state: gitlabState(mr.state), pipeline };
  },
};

/**
 * The failed jobs of a GitLab pipeline that failed it. Jobs of a child pipeline are not listed: its trigger job is a
 * bridge, so such a pipeline names fewer jobs or none, and its page shows them.
 */
async function gitlabFailedJobs(api: HostApi, project: HostedProject, pipeline: number): Promise<FailedJob[]> {
  const jobs = await api(
    `projects/${encodeURIComponent(project.path)}/pipelines/${pipeline}/jobs?scope[]=failed&per_page=${PIPELINE_FAILED_JOBS_MAX * 2}`,
    GitLabJobs,
  );
  return atMost(jobs.filter((job) => !job.allow_failure).map((job) => ({ name: job.name, url: job.web_url })));
}

const MERGE_REQUEST_APIS: Record<RepoHostKind, MergeRequestHostApi> = { github: githubApi, gitlab: gitlabApi };

/**
 * The form's address with as much of the description as fits in `FORM_URL_MAX`; a cut description ends with "…", and
 * the user adds the rest in the form.
 */
export function mergeRequestFormUrl(project: HostedProject, form: MergeRequestForm): string {
  const url = (description: string) => MERGE_REQUEST_APIS[project.kind].formUrl(project, { ...form, description });
  const whole = url(form.description);
  if (whole.length <= FORM_URL_MAX) return whole;
  // By code points, so a cut never splits an emoji; the longest prefix that fits, found by halving.
  const chars = Array.from(form.description);
  const cut = (n: number) => `${chars.slice(0, n).join("")}…`;
  let fits = 0;
  let tooLong = chars.length;
  while (tooLong - fits > 1) {
    const middle = Math.floor((fits + tooLong) / 2);
    if (url(cut(middle)).length <= FORM_URL_MAX) fits = middle;
    else tooLong = middle;
  }
  return url(cut(fits));
}

/** A branch name in a URL path: its `/` stay, as GitHub writes them, and everything else is escaped. */
function branchPath(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

/** The most recently updated merge request from `branch` in `project`, in any state; `null` when there is none. */
export function findMergeRequest(api: HostApi, project: HostedProject, branch: string): Promise<MergeRequest | null> {
  return MERGE_REQUEST_APIS[project.kind].find(api, project, branch);
}
