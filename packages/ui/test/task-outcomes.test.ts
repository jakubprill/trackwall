import { describe, expect, test } from "bun:test";
import type { FollowedMergeRequest, PipelineState, TaskOutcome } from "@trackwall/protocol";
import { outcomeMarks, PipelineFailures } from "../src/lib/task-outcomes.ts";

const TASK = "3f2a9c1e-0000-4000-8000-000000000000";

function mergeRequest(pipeline: PipelineState | null, extra: Partial<FollowedMergeRequest> = {}): FollowedMergeRequest {
  return {
    number: 12,
    title: "Add a discount",
    url: "https://gitlab.example.com/shop/-/merge_requests/12",
    state: "open",
    pipeline: pipeline && {
      state: pipeline,
      url: "https://gitlab.example.com/shop/-/pipelines/41",
      commit: "a".repeat(40),
      failedJobs:
        pipeline === "failed"
          ? [
              { name: "unit-tests", url: null },
              { name: "lint", url: null },
            ]
          : [],
    },
    project: { kind: "gitlab", host: "gitlab.example.com", path: "shop" },
    pipelineFailedAt: null,
    ...extra,
  };
}

function outcome(extra: Partial<TaskOutcome>): TaskOutcome {
  return { task: TASK, repo: "orders-api", verification: null, mergeRequest: null, ...extra };
}

describe("the marks on a task's row", () => {
  test("the verdict, then the merge request's number in the tone of its pipeline, with the story as the tooltip", () => {
    expect(outcomeMarks(outcome({ verification: "passed", mergeRequest: mergeRequest("failed") }))).toEqual([
      { key: "verification", tone: "ok", label: "Verified", title: "Verification passed" },
      {
        key: "merge-request",
        tone: "error",
        label: "!12",
        title: "!12 Add a discount · open · pipeline failed: unit-tests, lint",
      },
    ]);
  });

  test("a pull request on GitHub is #12; once merged its tone is the merge, not the last pipeline", () => {
    const merged = mergeRequest("failed", { state: "merged", project: { kind: "github", host: "github.com", path: "me/shop" } });
    expect(outcomeMarks(outcome({ mergeRequest: merged }))).toEqual([
      { key: "merge-request", tone: "ok", label: "#12", title: "#12 Add a discount · merged · pipeline failed: unit-tests, lint" },
    ]);
  });

  test("a running verification and an open merge request without a pipeline", () => {
    expect(outcomeMarks(outcome({ verification: "running", mergeRequest: mergeRequest(null) }))).toEqual([
      { key: "verification", tone: "warning", label: "Verifying", title: "Verification running" },
      { key: "merge-request", tone: "warning", label: "!12", title: "!12 Add a discount · open" },
    ]);
  });

  test("a task without an outcome has no marks", () => {
    expect(outcomeMarks(undefined)).toEqual([]);
  });
});

describe("notifications of a failed pipeline", () => {
  const running = outcome({ mergeRequest: mergeRequest("running") });
  const failed = outcome({ mergeRequest: mergeRequest("failed", { pipelineFailedAt: "2026-10-31T08:00:00.000Z" }) });

  test("a new failure time is announced once, with the failed jobs, and opens the task", () => {
    const failures = new PipelineFailures();
    expect(failures.next([running])).toEqual([]);
    expect(failures.next([failed])).toEqual([
      {
        title: "Pipeline failed in orders-api",
        body: "!12 Add a discount\nFailed: unit-tests, lint",
        tag: `trackwall:pipeline:${TASK}`,
        target: { kind: "task", id: TASK },
      },
    ]);
    expect(failures.next([failed])).toEqual([]);
  });

  test("a failure already there at the first list is not announced, a later one on the same task is", () => {
    const failures = new PipelineFailures();
    expect(failures.next([failed])).toEqual([]);
    const again = outcome({ mergeRequest: mergeRequest("failed", { pipelineFailedAt: "2026-10-31T09:00:00.000Z" }) });
    expect(failures.next([again]).map((n) => n.title)).toEqual(["Pipeline failed in orders-api"]);
  });
});
