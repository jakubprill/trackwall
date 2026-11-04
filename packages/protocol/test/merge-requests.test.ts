import { describe, expect, test } from "bun:test";
import { mergeRequestNumber, pipelineStateText } from "../src/merge-requests.ts";
import { TaskUpdate } from "../src/task-updates.ts";

describe("a merge request's number", () => {
  test("is written as each repo host writes it", () => {
    expect(mergeRequestNumber({ kind: "gitlab", host: "gitlab.example.com", path: "shop/shop" }, 12)).toBe("!12");
    expect(mergeRequestNumber({ kind: "github", host: "github.com", path: "me/shop" }, 7)).toBe("#7");
  });
});

describe("a pipeline's state in words", () => {
  test("names the state, and a pipeline held at a manual job says it waits for it", () => {
    expect(pipelineStateText("failed")).toBe("pipeline failed");
    expect(pipelineStateText("manual")).toBe("pipeline waits for a manual job");
  });
});

describe("a failed job kept from before job logs (ADR-197)", () => {
  test("an unread pipeline_failed update without job ids still loads, so the agent queues are not thrown away", () => {
    const stored = {
      kind: "pipeline_failed",
      task: "6f1d0a52-2c41-4a8e-9a3f-0c5a1b2d3e4f",
      session: null,
      at: "2026-11-03T10:00:00.000Z",
      mergeRequest: "https://gitlab.example.com/shop/-/merge_requests/12",
      pipeline: "https://gitlab.example.com/shop/-/pipelines/41",
      failedJobs: [{ name: "unit-tests", url: "https://gitlab.example.com/shop/-/jobs/7" }],
    };

    expect(TaskUpdate.parse(stored)).toMatchObject({
      failedJobs: [{ name: "unit-tests", url: "https://gitlab.example.com/shop/-/jobs/7", id: null }],
    });
  });
});
