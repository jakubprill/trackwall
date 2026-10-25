import { describe, expect, test } from "bun:test";
import type { BatchRun, BatchStepResult } from "@trackwall/protocol";
import { batchProgress, batchRunLabel, stepLabel, stepMessage } from "../src/lib/batch-state.ts";

describe("batch command in the UI", () => {
  test("a step has a short text: a running one warns, a done one shows the sync result, a failed one is an error", () => {
    const steps: BatchStepResult[] = [
      { step: "sync", state: "waiting" },
      { step: "sync", state: "running" },
      { step: "sync", state: "done", detail: "main +2" },
      { step: "build", state: "done", detail: null },
      { step: "setup", state: "skipped", message: "the repo has no setup mise task" },
      { step: "build", state: "failed", message: "exited with code 1", lastLines: [] },
      { step: "tools", state: "cancelled" },
    ];
    expect(steps.map(stepLabel)).toEqual([
      { label: "waiting" },
      { tone: "warning", label: "running…" },
      { tone: "ok", label: "main +2" },
      { tone: "ok", label: "done" },
      { label: "skipped" },
      { tone: "error", label: "failed" },
      { label: "cancelled" },
    ]);
    expect(steps.map(stepMessage)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      "the repo has no setup mise task",
      "exited with code 1",
      undefined,
    ]);
  });

  test("progress counts repos where no step is waiting or running, and repos with an error separately", () => {
    const repo = { repo: "api", path: "/projects/api" };
    const run: BatchRun = {
      startedAt: "2026-10-23T10:00:00Z",
      finishedAt: null,
      cancelled: false,
      repos: [
        {
          ...repo,
          steps: [
            { step: "sync", state: "done", detail: "main up to date" },
            { step: "build", state: "running" },
          ],
        },
        {
          ...repo,
          steps: [
            { step: "sync", state: "waiting" },
            { step: "build", state: "waiting" },
          ],
        },
        {
          ...repo,
          steps: [
            { step: "sync", state: "done", detail: null },
            { step: "build", state: "done", detail: null },
          ],
        },
        {
          ...repo,
          steps: [
            { step: "sync", state: "failed", message: "Permission denied (publickey).", lastLines: [] },
            { step: "build", state: "skipped", message: "skipped after step sync failed" },
          ],
        },
      ],
    };
    expect(batchProgress(run)).toEqual({ done: 2, total: 4, failed: 1 });
  });

  test("the results header says whether the command is running or finished, and whether it was cancelled", () => {
    const run = { startedAt: "2026-10-23T10:00:00Z", repos: [] };
    const now = new Date("2026-10-23T10:00:30Z");
    expect(batchRunLabel({ ...run, finishedAt: null, cancelled: false }, now)).toBe("Running");
    expect(batchRunLabel({ ...run, finishedAt: null, cancelled: true }, now)).toBe("Cancelling");
    expect(batchRunLabel({ ...run, finishedAt: "2026-10-23T10:00:20Z", cancelled: false }, now)).toBe("Finished just now");
    expect(batchRunLabel({ ...run, finishedAt: "2026-10-23T10:00:20Z", cancelled: true }, now)).toBe("Cancelled just now");
  });
});
