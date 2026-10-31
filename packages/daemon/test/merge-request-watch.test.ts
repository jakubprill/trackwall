import { describe, expect, test } from "bun:test";
import type { MergeRequest, PipelineState } from "@trackwall/protocol";
import {
  ACTIVE_CHECK_MS,
  DONE_CHECK_MS,
  nextCheckMs,
  pipelineFailedNow,
  SETTLED_CHECK_MS,
} from "../src/modules/merge-requests/watch-schedule.ts";

const PROJECT = { kind: "gitlab", host: "gitlab.example.com", path: "shop" } as const;
const FIRST = "a".repeat(40);
const SECOND = "b".repeat(40);

function mergeRequest(state: PipelineState | null, commit = FIRST, number = 12, mrState: MergeRequest["state"] = "open"): MergeRequest {
  return {
    number,
    title: "Add a discount",
    url: `https://gitlab.example.com/shop/-/merge_requests/${number}`,
    state: mrState,
    pipeline: state === null ? null : { state, url: "https://gitlab.example.com/shop/-/pipelines/1", commit, failedJobs: [] },
  };
}

describe("how often a task's merge request is read", () => {
  test("every minute while its pipeline waits or runs", () => {
    expect(nextCheckMs({ kind: "found", project: PROJECT, mergeRequest: mergeRequest("running") })).toBe(ACTIVE_CHECK_MS);
    expect(nextCheckMs({ kind: "found", project: PROJECT, mergeRequest: mergeRequest("pending") })).toBe(ACTIVE_CHECK_MS);
  });

  test("every few minutes once the pipeline settled, before a merge request exists, and when the repo host could not be asked", () => {
    expect(nextCheckMs({ kind: "found", project: PROJECT, mergeRequest: mergeRequest("failed") })).toBe(SETTLED_CHECK_MS);
    expect(nextCheckMs({ kind: "found", project: PROJECT, mergeRequest: mergeRequest("manual") })).toBe(SETTLED_CHECK_MS);
    expect(nextCheckMs({ kind: "found", project: PROJECT, mergeRequest: mergeRequest(null) })).toBe(SETTLED_CHECK_MS);
    expect(nextCheckMs({ kind: "none" })).toBe(SETTLED_CHECK_MS);
    expect(nextCheckMs({ kind: "unknown" })).toBe(SETTLED_CHECK_MS);
  });

  test("every quarter of an hour once it is merged or closed", () => {
    expect(nextCheckMs({ kind: "found", project: PROJECT, mergeRequest: mergeRequest("running", FIRST, 12, "merged") })).toBe(
      DONE_CHECK_MS,
    );
    expect(nextCheckMs({ kind: "found", project: PROJECT, mergeRequest: mergeRequest("failed", FIRST, 12, "closed") })).toBe(DONE_CHECK_MS);
  });
});

describe("a new pipeline failure", () => {
  test("is a failed pipeline that was running, or that the read before did not have", () => {
    expect(pipelineFailedNow(mergeRequest("running"), mergeRequest("failed"))).toBe(true);
    expect(pipelineFailedNow(mergeRequest(null), mergeRequest("failed"))).toBe(true);
    expect(pipelineFailedNow(null, mergeRequest("failed"))).toBe(true);
  });

  test("is a failure on a later commit, or of another merge request, even when the one before failed too", () => {
    expect(pipelineFailedNow(mergeRequest("failed", FIRST), mergeRequest("failed", SECOND))).toBe(true);
    expect(pipelineFailedNow(mergeRequest("failed", FIRST, 12), mergeRequest("failed", FIRST, 13))).toBe(true);
  });

  test("is not the same failure read again, a failure at the first read since the daemon started, or any other state", () => {
    expect(pipelineFailedNow(mergeRequest("failed"), mergeRequest("failed"))).toBe(false);
    expect(pipelineFailedNow(undefined, mergeRequest("failed"))).toBe(false);
    expect(pipelineFailedNow(mergeRequest("running"), mergeRequest("passed"))).toBe(false);
    expect(pipelineFailedNow(mergeRequest("failed"), null)).toBe(false);
  });
});
