import { describe, expect, test } from "bun:test";
import { fakeHosting } from "./support/hosting.ts";

const GITLAB = { kind: "gitlab", host: "gitlab.example.com", path: "shop/backend/orders" } as const;
const GITHUB = { kind: "github", host: "github.com", path: "me/shop" } as const;
const SHA = "a".repeat(40);
const BRANCH = "trackwall/add-a-discount-1a2b3c";

const GITLAB_MRS = "projects/shop%2Fbackend%2Forders/merge_requests";
const GITHUB_COMMIT = `repos/me/shop/commits/${SHA}`;

const gitlabMr = (state: string, pipeline: { status: string; web_url: string } | null) => ({
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
  check_runs: runs.map(([status, conclusion]) => ({ status, conclusion })),
});
const NO_STATUSES = { state: "pending", total_count: 0 };

describe("the merge request of a task branch on GitLab", () => {
  test("is found by its source branch, with the pipeline of its last commit", async () => {
    const { hosting, calls } = fakeHosting({
      apiResponses: {
        [GITLAB_MRS]: [{ iid: 12 }],
        [`${GITLAB_MRS}/12`]: gitlabMr("opened", { status: "running", web_url: "https://gitlab.example.com/p/1" }),
      },
    });

    expect(await hosting.mergeRequest(GITLAB, BRANCH)).toEqual({
      number: 12,
      title: "Add a discount",
      url: "https://gitlab.example.com/shop/backend/orders/-/merge_requests/12",
      state: "open",
      pipeline: { state: "running", url: "https://gitlab.example.com/p/1" },
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
      apiResponses: { [GITLAB_MRS]: [{ iid: 12 }], [`${GITLAB_MRS}/12`]: gitlabMr("locked", { status: "manual", web_url: "u" }) },
    });
    expect(await manual.hosting.mergeRequest(GITLAB, BRANCH)).toMatchObject({ state: "open", pipeline: { state: "manual" } });

    const waiting = fakeHosting({
      apiResponses: {
        [GITLAB_MRS]: [{ iid: 12 }],
        [`${GITLAB_MRS}/12`]: gitlabMr("closed", { status: "waiting_for_resource", web_url: "u" }),
      },
    });
    expect(await waiting.hosting.mergeRequest(GITLAB, BRANCH)).toMatchObject({ state: "closed", pipeline: { state: "pending" } });
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
      pipeline: { state: "running", url: "https://github.com/me/shop/pull/7/checks" },
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
    expect((await failedCheck.hosting.mergeRequest(GITHUB, BRANCH))?.pipeline?.state).toBe("failed");

    const failedStatus = fakeHosting({
      apiResponses: {
        "repos/me/shop/pulls": githubPull("open", null),
        [`${GITHUB_COMMIT}/check-runs`]: checkRuns(["completed", "success"]),
        [`${GITHUB_COMMIT}/status`]: { state: "error", total_count: 1 },
      },
    });
    expect((await failedStatus.hosting.mergeRequest(GITHUB, BRANCH))?.pipeline?.state).toBe("failed");
  });

  test("checks beyond the pages read count as pending, so an unread failure never shows as a pass", async () => {
    const { hosting } = fakeHosting({
      apiResponses: {
        "repos/me/shop/pulls": githubPull("open", null),
        [`${GITHUB_COMMIT}/check-runs`]: {
          total_count: 900,
          check_runs: Array.from({ length: 100 }, () => ({ status: "completed", conclusion: "success" })),
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
        [`${GITHUB_COMMIT}/status`]: { state: "success", total_count: 2 },
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
