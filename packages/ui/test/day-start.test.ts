import { describe, expect, test } from "bun:test";
import type { DayStartRun } from "@trackwall/protocol";
import { dayStartFailure, dayStartLabel } from "../src/lib/day-start.ts";

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
    expect(dayStartFailure(run({ step: "supervisor", finishedAt: ended, error: "no Copilot CLI in PATH" }))).toBe(
      "Start my day stopped while starting the supervisor: no Copilot CLI in PATH",
    );
    expect(dayStartFailure(run({ step: "sync", error: "set the projects folder first" }))).toBeUndefined();
    expect(
      dayStartFailure(run({ step: "supervisor", finishedAt: ended, supervisor: "8a6e0c7e-3b0f-4a43-9d0e-6e7fd0a0c001" })),
    ).toBeUndefined();
    expect(dayStartFailure(null)).toBeUndefined();
  });
});
