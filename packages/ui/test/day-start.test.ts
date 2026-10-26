import { describe, expect, test } from "bun:test";
import type { DayStartRun } from "@trackwall/protocol";
import { dayStartFailure, dayStartLabel, startErrorShown } from "../src/lib/day-start.ts";

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
  test("the button names the running step, and otherwise itself", () => {
    expect(dayStartLabel(undefined)).toBe("Start my day");
    expect(dayStartLabel(null)).toBe("Start my day");
    expect(dayStartLabel(run({ step: "sync" }))).toBe("Syncing repos…");
    expect(dayStartLabel(run({ step: "report" }))).toBe("Writing the day report…");
    expect(dayStartLabel(run({ step: "supervisor" }))).toBe("Starting the supervisor…");
    expect(dayStartLabel(run({ step: "supervisor", finishedAt: ended }))).toBe("Start my day");
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
