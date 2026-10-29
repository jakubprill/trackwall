import { describe, expect, test } from "bun:test";
import type { DayStartRun } from "@trackwall/protocol";
import { dayStartFailure, dayStartSteps, startErrorShown } from "../src/lib/day-start.ts";

const run = (fields: Partial<DayStartRun>): DayStartRun => ({
  startedAt: "2026-10-26T07:00:00.000Z",
  finishedAt: null,
  step: "sync",
  error: null,
  supervisor: null,
  ...fields,
});
const ended = "2026-10-26T07:02:00.000Z";

describe("the day start in the UI", () => {
  test("a running day start lists its steps: done, the one under way, and those ahead; a finished one lists none", () => {
    expect(dayStartSteps(run({ step: "report" }))).toEqual([
      { label: "Sync every repo", status: "done" },
      { label: "Write what changed since your last day start", status: "now" },
      { label: "Start the supervisor with the briefing", status: "next" },
    ]);
    expect(dayStartSteps(run({ step: "sync" })).map((s) => s.status)).toEqual(["now", "next", "next"]);
    expect(dayStartSteps(run({ step: "supervisor", finishedAt: ended }))).toEqual([]);
    expect(dayStartSteps(null)).toEqual([]);
    expect(dayStartSteps(undefined)).toEqual([]);
  });

  test("a day start that stopped says in which step and why; a running or successful one says nothing", () => {
    const failed = run({ step: "supervisor", finishedAt: ended, error: "no Copilot CLI in PATH" });
    expect(dayStartFailure(failed, undefined)).toBe("Start my day stopped while starting the supervisor: no Copilot CLI in PATH");
    // A supervisor from before the day start does not hide it.
    expect(dayStartFailure(failed, "2026-10-25T16:00:00.000Z")).toBe(
      "Start my day stopped while starting the supervisor: no Copilot CLI in PATH",
    );
    expect(dayStartFailure(run({ step: "sync", error: "set the projects folder first" }), undefined)).toBeUndefined();
    const succeeded = run({ step: "supervisor", finishedAt: ended, supervisor: "8a6e0c7e-3b0f-4a43-9d0e-6e7fd0a0c001" });
    expect(dayStartFailure(succeeded, undefined)).toBeUndefined();
    expect(dayStartFailure(null, undefined)).toBeUndefined();
  });

  test("a supervisor started after a failed day start hides the failure, so an old message does not come back", () => {
    const failed = run({ step: "supervisor", finishedAt: ended, error: "no Copilot CLI in PATH" });
    expect(dayStartFailure(failed, "2026-10-26T07:05:00.000Z")).toBeUndefined();
  });

  test("the panel shows the error of the start button pressed last, so an old day start failure stays hidden after a plain start", () => {
    const failedDay = run({ step: "sync", finishedAt: ended, error: "the sync failed" });
    const afterPlainStart = {
      supervisorError: "no Copilot CLI in PATH",
      dayError: undefined,
      dayRun: failedDay,
      supervisorStartedAt: undefined,
    };
    expect(startErrorShown({ lastStart: "supervisor", ...afterPlainStart })).toBe("no Copilot CLI in PATH");
    expect(startErrorShown({ lastStart: "supervisor", ...afterPlainStart, supervisorError: undefined })).toBeUndefined();
    expect(startErrorShown({ lastStart: "day", ...afterPlainStart })).toBe("Start my day stopped while syncing the repos: the sync failed");
    expect(startErrorShown({ lastStart: "day", ...afterPlainStart, dayError: "set the projects folder first" })).toBe(
      "set the projects folder first",
    );
  });
});
