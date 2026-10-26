import type { HostedProject, MergeRequest, Pipeline, PipelineState, RepoHostKind } from "@trackwall/protocol";
import { z } from "zod";

/**
 * How GitHub and GitLab differ for a task's merge request (ADR-77): the address of the new merge request form with its
 * fields filled in, and the API paths and response fields of the merge request from a source branch and its pipeline.
 * Only reads go through the API; the user creates the merge request in the form. Running `gh` and `glab` is in
 * `hosting.ts`, the rest are pure functions.
 */

/** One `<cli> api` call: the response as JSON, checked by the caller's schema. */
export type HostApi = (path: string) => Promise<unknown>;

export interface MergeRequestForm {
  source: string;
  /** `null` lets the repo host pick its default branch. */
  target: string | null;
  title: string;
  description: string;
}

export interface MergeRequestHostApi {
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
  check_runs: z.array(z.object({ status: z.string(), conclusion: z.string().nullable() })),
});

const GitHubCombinedStatus = z.object({
  state: z.string(),
  total_count: z.number().int().nonnegative(),
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

/** GitHub's combined status of the commit statuses other CI systems set; `pending` while one has not reported. */
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
    const [pull] = z
      .array(GitHubPull)
      .parse(await api(`repos/${project.path}/pulls?head=${head}&state=all&sort=updated&direction=desc&per_page=1`));
    if (!pull) return null;
    const commit = `repos/${project.path}/commits/${pull.head.sha}`;
    const [runs, status] = await Promise.all([
      api(`${commit}/check-runs?per_page=100`).then((json) => GitHubCheckRuns.parse(json)),
      api(`${commit}/status`).then((json) => GitHubCombinedStatus.parse(json)),
    ]);
    const states = [...runs.check_runs.map(checkRunState), ...(status.total_count > 0 ? [statusState(status.state)] : [])];
    const state = combinedState(states);
    return {
      number: pull.number,
      title: pull.title,
      url: pull.html_url,
      state: pull.merged_at !== null ? "merged" : pull.state,
      pipeline: state === null ? null : { state, url: `${pull.html_url}/checks` },
    };
  },
};

const GitLabMergeRequests = z.array(z.object({ iid: z.number().int().positive() }));

const GitLabMergeRequest = z.object({
  iid: z.number().int().positive(),
  title: z.string(),
  web_url: z.string(),
  state: z.string(),
  head_pipeline: z.object({ status: z.string(), web_url: z.string() }).nullish(),
});

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
    const [found] = GitLabMergeRequests.parse(
      await api(`${base}?source_branch=${encodeURIComponent(branch)}&state=all&order_by=updated_at&sort=desc&per_page=1`),
    );
    if (!found) return null;
    // The list leaves out the pipeline; one merge request carries it.
    const mr = GitLabMergeRequest.parse(await api(`${base}/${found.iid}`));
    const pipeline: Pipeline | null = mr.head_pipeline
      ? { state: gitlabPipelineState(mr.head_pipeline.status), url: mr.head_pipeline.web_url }
      : null;
    return { number: mr.iid, title: mr.title, url: mr.web_url, state: gitlabState(mr.state), pipeline };
  },
};

export const MERGE_REQUEST_APIS: Record<RepoHostKind, MergeRequestHostApi> = { github: githubApi, gitlab: gitlabApi };

/** A branch name in a URL path: its `/` stay, as GitHub writes them, and everything else is escaped. */
function branchPath(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}
