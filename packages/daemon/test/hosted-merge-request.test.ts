import { describe, expect, test } from "bun:test";
import { fakeHosting } from "./support/hosting.ts";

const GITLAB = { kind: "gitlab", host: "gitlab.example.com", path: "shop/backend/orders" } as const;
const GITHUB = { kind: "github", host: "github.com", path: "me/shop" } as const;
const SHA = "a".repeat(40);
const BRANCH = "trackwall/add-a-discount-1a2b3c";

const GITLAB_MRS = "projects/shop%2Fbackend%2Forders/merge_requests";
const GITHUB_COMMIT = `repos/me/shop/commits/${SHA}`;

const gitlabPipeline = (status: string, web_url: string) => ({ id: 41, sha: SHA, status, web_url });
const GITLAB_JOBS = "projects/shop%2Fbackend%2Forders/pipelines/41/jobs";

const gitlabMr = (state: string, pipeline: ReturnType<typeof gitlabPipeline> | null) => ({
  iid: 12,
  title: "Add a discount",
  web_url: "https://gitlab.example.com/shop/backend/orders/-/merge_requests/12",
  state,
  head_pipeline: pipeline,
});

const githubPull = (state: "open" | "closed", mergedAt: string | null) => [
  { number: 7, title: "Add a discount", html_url: "https://github.com/me/shop/pull/7", state, merged_at: mergedAt, head: { sha: SHA } },
];

const checkRuns = (...runs: [string, string | null][]) => ({
  total_count: runs.length,
  check_runs: runs.map(([status, conclusion], i) => ({
    id: i + 1,
    name: `check ${i + 1}`,
    app: { slug: "github-actions" },
    status,
    conclusion,
    html_url: `https://github.com/me/shop/runs/${i + 1}`,
  })),
});
const NO_STATUSES = { state: "pending", total_count: 0, statuses: [] };

describe("the merge request of a task branch on GitLab", () => {
  test("is found by its source branch, with the pipeline of its last commit", async () => {
    const { hosting, calls } = fakeHosting({
      apiResponses: {
        [GITLAB_MRS]: [{ iid: 12 }],
        [`${GITLAB_MRS}/12`]: gitlabMr("opened", gitlabPipeline("running", "https://gitlab.example.com/p/1")),
      },
    });

    expect(await hosting.mergeRequest(GITLAB, BRANCH)).toEqual({
      number: 12,
      title: "Add a discount",
      url: "https://gitlab.example.com/shop/backend/orders/-/merge_requests/12",
      state: "open",
      pipeline: { state: "running", url: "https://gitlab.example.com/p/1", commit: SHA, failedJobs: [] },
    });
    const [list, one] = calls();
    expect(list?.args.slice(0, 3)).toEqual(["api", "--hostname", "gitlab.example.com"]);
    expect(list?.args[3]).toBe(
      `${GITLAB_MRS}?source_branch=trackwall%2Fadd-a-discount-1a2b3c&state=all&order_by=updated_at&sort=desc&per_page=1`,
    );
    expect(one?.args[3]).toBe(`${GITLAB_MRS}/12`);
  });

  test("a merged one without a pipeline, and GitLab's own pipeline statuses", async () => {
    const merged = fakeHosting({
      apiResponses: { [GITLAB_MRS]: [{ iid: 12 }], [`${GITLAB_MRS}/12`]: gitlabMr("merged", null) },
    });
    expect(await merged.hosting.mergeRequest(GITLAB, BRANCH)).toMatchObject({ state: "merged", pipeline: null });

    const manual = fakeHosting({
      apiResponses: { [GITLAB_MRS]: [{ iid: 12 }], [`${GITLAB_MRS}/12`]: gitlabMr("locked", gitlabPipeline("manual", "u")) },
    });
    expect(await manual.hosting.mergeRequest(GITLAB, BRANCH)).toMatchObject({ state: "open", pipeline: { state: "manual" } });

    const waiting = fakeHosting({
      apiResponses: {
        [GITLAB_MRS]: [{ iid: 12 }],
        [`${GITLAB_MRS}/12`]: gitlabMr("closed", gitlabPipeline("waiting_for_resource", "u")),
      },
    });
    expect(await waiting.hosting.mergeRequest(GITLAB, BRANCH)).toMatchObject({ state: "closed", pipeline: { state: "pending" } });
  });

  test("a failed pipeline names the jobs that failed it, leaving out those allowed to fail", async () => {
    const { hosting, calls } = fakeHosting({
      apiResponses: {
        [GITLAB_MRS]: [{ iid: 12 }],
        [`${GITLAB_MRS}/12`]: gitlabMr("opened", gitlabPipeline("failed", "https://gitlab.example.com/p/41")),
        [GITLAB_JOBS]: [
          { id: 1, name: "unit-tests", web_url: "https://gitlab.example.com/j/1", allow_failure: false },
          { id: 2, name: "flaky-e2e", web_url: "https://gitlab.example.com/j/2", allow_failure: true },
          { id: 3, name: "lint", web_url: "https://gitlab.example.com/j/3", allow_failure: false },
        ],
      },
    });

    expect((await hosting.mergeRequest(GITLAB, BRANCH))?.pipeline).toEqual({
      state: "failed",
      url: "https://gitlab.example.com/p/41",
      commit: SHA,
      failedJobs: [
        { name: "unit-tests", url: "https://gitlab.example.com/j/1", id: "1" },
        { name: "lint", url: "https://gitlab.example.com/j/3", id: "3" },
      ],
    });
    expect(calls()[2]?.args[3]).toBe(`${GITLAB_JOBS}?scope[]=failed&per_page=20`);
  });

  test("a pipeline that did not fail costs no call for its jobs", async () => {
    const { hosting, calls } = fakeHosting({
      apiResponses: {
        [GITLAB_MRS]: [{ iid: 12 }],
        [`${GITLAB_MRS}/12`]: gitlabMr("opened", gitlabPipeline("success", "u")),
      },
    });

    expect((await hosting.mergeRequest(GITLAB, BRANCH))?.pipeline).toMatchObject({ state: "passed", failedJobs: [] });
    expect(calls()).toHaveLength(2);
  });

  test("none when no merge request has the branch as its source", async () => {
    const { hosting, calls } = fakeHosting({ apiResponses: { [GITLAB_MRS]: [] } });

    expect(await hosting.mergeRequest(GITLAB, BRANCH)).toBeNull();
    expect(calls()).toHaveLength(1);
  });

  test("a response unlike the API is an error without the response in it", async () => {
    const { hosting } = fakeHosting({ apiResponses: { [GITLAB_MRS]: { message: "secret page" } } });

    await expect(hosting.mergeRequest(GITLAB, BRANCH)).rejects.toThrow(
      "glab api returned a response that does not match the gitlab.example.com API",
    );
  });

  test("an error from glab is the error of the lookup", async () => {
    const { hosting } = fakeHosting({ apiErrors: { "gitlab.example.com": "glab: not logged in" } });

    await expect(hosting.mergeRequest(GITLAB, BRANCH)).rejects.toThrow("glab: not logged in");
  });
});

describe("the pull request of a task branch on GitHub", () => {
  test("is found by owner and branch, and its checks and statuses sum up to one pipeline", async () => {
    const { hosting, calls } = fakeHosting({
      apiResponses: {
        "repos/me/shop/pulls": githubPull("open", null),
        [`${GITHUB_COMMIT}/check-runs`]: checkRuns(["completed", "success"], ["in_progress", null], ["completed", "skipped"]),
        [`${GITHUB_COMMIT}/status`]: NO_STATUSES,
      },
    });

    expect(await hosting.mergeRequest(GITHUB, BRANCH)).toEqual({
      number: 7,
      title: "Add a discount",
      url: "https://github.com/me/shop/pull/7",
      state: "open",
      pipeline: { state: "running", url: "https://github.com/me/shop/pull/7/checks", commit: SHA, failedJobs: [] },
    });
    expect(calls()[0]?.args[3]).toBe(
      "repos/me/shop/pulls?head=me%3Atrackwall%2Fadd-a-discount-1a2b3c&state=all&sort=updated&direction=desc&per_page=1",
    );
  });

  test("one failed check or status fails the pipeline, even while others run", async () => {
    const failedCheck = fakeHosting({
      apiResponses: {
        "repos/me/shop/pulls": githubPull("open", null),
        [`${GITHUB_COMMIT}/check-runs`]: checkRuns(["queued", null], ["completed", "timed_out"]),
        [`${GITHUB_COMMIT}/status`]: NO_STATUSES,
      },
    });
    expect((await failedCheck.hosting.mergeRequest(GITHUB, BRANCH))?.pipeline).toMatchObject({
      state: "failed",
      failedJobs: [{ name: "check 2", url: "https://github.com/me/shop/runs/2", id: "2" }],
    });

    const failedStatus = fakeHosting({
      apiResponses: {
        "repos/me/shop/pulls": githubPull("open", null),
        [`${GITHUB_COMMIT}/check-runs`]: checkRuns(["completed", "success"]),
        [`${GITHUB_COMMIT}/status`]: {
          state: "error",
          total_count: 2,
          statuses: [
            { context: "ci/jenkins", state: "error", target_url: null },
            { context: "ci/sonar", state: "success", target_url: "https://sonar.example.com/1" },
          ],
        },
      },
    });
    expect((await failedStatus.hosting.mergeRequest(GITHUB, BRANCH))?.pipeline).toMatchObject({
      state: "failed",
      failedJobs: [{ name: "ci/jenkins", url: null, id: null }],
    });
  });

  test("only a GitHub Actions check has a job id to read its log by; another app's check keeps its log itself", async () => {
    const { hosting } = fakeHosting({
      apiResponses: {
        "repos/me/shop/pulls": githubPull("open", null),
        [`${GITHUB_COMMIT}/check-runs`]: {
          total_count: 2,
          check_runs: [
            { id: 801, name: "build", status: "completed", conclusion: "failure", html_url: "u1", app: { slug: "github-actions" } },
            { id: 802, name: "sonar", status: "completed", conclusion: "failure", html_url: "u2", app: { slug: "sonarcloud" } },
          ],
        },
        [`${GITHUB_COMMIT}/status`]: NO_STATUSES,
      },
    });

    expect((await hosting.mergeRequest(GITHUB, BRANCH))?.pipeline?.failedJobs).toEqual([
      { name: "build", url: "u1", id: "801" },
      { name: "sonar", url: "u2", id: null },
    ]);
  });

  test("checks beyond the pages read count as pending, so an unread failure never shows as a pass", async () => {
    const { hosting } = fakeHosting({
      apiResponses: {
        "repos/me/shop/pulls": githubPull("open", null),
        [`${GITHUB_COMMIT}/check-runs`]: {
          total_count: 900,
          check_runs: Array.from({ length: 100 }, (_, i) => ({
            id: i + 1,
            name: "c",
            status: "completed",
            conclusion: "success",
            html_url: null,
          })),
        },
        [`${GITHUB_COMMIT}/status`]: NO_STATUSES,
      },
    });

    expect((await hosting.mergeRequest(GITHUB, BRANCH))?.pipeline?.state).toBe("pending");
  });

  test("a merged pull request, and no pipeline when nothing ran on its commit", async () => {
    const { hosting } = fakeHosting({
      apiResponses: {
        "repos/me/shop/pulls": githubPull("closed", "2026-10-26T10:00:00Z"),
        [`${GITHUB_COMMIT}/check-runs`]: checkRuns(),
        [`${GITHUB_COMMIT}/status`]: NO_STATUSES,
      },
    });

    expect(await hosting.mergeRequest(GITHUB, BRANCH)).toMatchObject({ state: "merged", pipeline: null });
  });

  test("all checks passed or skipped is a pass, and a closed one without a merge stays closed", async () => {
    const { hosting } = fakeHosting({
      apiResponses: {
        "repos/me/shop/pulls": githubPull("closed", null),
        [`${GITHUB_COMMIT}/check-runs`]: checkRuns(["completed", "success"], ["completed", "neutral"], ["completed", "skipped"]),
        [`${GITHUB_COMMIT}/status`]: {
          state: "success",
          total_count: 2,
          statuses: [
            { context: "ci/a", state: "success", target_url: null },
            { context: "ci/b", state: "success", target_url: null },
          ],
        },
      },
    });

    expect(await hosting.mergeRequest(GITHUB, BRANCH)).toMatchObject({ state: "closed", pipeline: { state: "passed" } });
  });
});

describe("the new merge request form", () => {
  const form = { source: BRANCH, target: "main", title: "Add a discount", description: "Adds 10% off.\n\nVerification: passed" };

  test("on GitLab carries the branches, the title and the description as form fields", () => {
    const url = new URL(fakeHosting().hosting.mergeRequestForm({ ...GITLAB, host: "gitlab.example.com:8443" }, form));

    expect(`${url.origin}${url.pathname}`).toBe("https://gitlab.example.com:8443/shop/backend/orders/-/merge_requests/new");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      "merge_request[source_branch]": BRANCH,
      "merge_request[target_branch]": "main",
      "merge_request[title]": "Add a discount",
      "merge_request[description]": "Adds 10% off.\n\nVerification: passed",
    });
  });

  test("on GitHub compares the target with the task branch, and without a target lets GitHub pick its default", () => {
    const url = new URL(fakeHosting().hosting.mergeRequestForm(GITHUB, form));
    expect(url.pathname).toBe(`/me/shop/compare/main...${BRANCH}`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ quick_pull: "1", title: "Add a discount", body: form.description });

    const noTarget = new URL(fakeHosting().hosting.mergeRequestForm(GITHUB, { ...form, target: null }));
    expect(noTarget.pathname).toBe(`/me/shop/compare/${BRANCH}`);
  });
});

describe("the log of a failed job", () => {
  test("is read as plain text from GitLab's trace and from a GitHub Actions job", async () => {
    const { hosting, calls } = fakeHosting({
      apiResponses: {
        "projects/shop%2Fbackend%2Forders/jobs/501/trace": "ERROR: Job failed: exit code 1\n",
        "repos/me/shop/actions/jobs/801/logs": "2026-11-04T10:00:00.0000000Z Process completed with exit code 1.\n",
      },
    });

    expect(await hosting.jobLog(GITLAB, "501")).toEqual({ raw: "ERROR: Job failed: exit code 1\n", cut: false });
    expect(await hosting.jobLog(GITHUB, "801")).toEqual({
      raw: "2026-11-04T10:00:00.0000000Z Process completed with exit code 1.\n",
      cut: false,
    });
    expect(calls().map((call) => call.args.slice(0, 4))).toEqual([
      ["api", "--hostname", "gitlab.example.com", "projects/shop%2Fbackend%2Forders/jobs/501/trace"],
      ["api", "--hostname", "github.com", "repos/me/shop/actions/jobs/801/logs"],
    ]);
  });
});
