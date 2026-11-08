import { describe, expect, test } from "bun:test";
import type { ReproductionCheck } from "@trackwall/protocol";
import { checksTest, reproductionFilterNote, reproductionLabel, reproductionRunsLine, shownCheck } from "../src/lib/reproduction.ts";

const TEST = { file: "src/test/java/com/example/shop/CartTest.java", name: "CartTest#sums", failure: "expected 3 but was 4" };

const CHECK: ReproductionCheck = {
  task: "44444444-4444-4444-8444-444444444444",
  repo: "shop",
  test: TEST,
  filter: "CartTest",
  state: "reproduced",
  phase: null,
  startedAt: "2026-11-08T10:00:00.000Z",
  finishedAt: "2026-11-08T10:01:00.000Z",
  base: {
    runId: "run-1",
    exitCode: 1,
    outcome: "failed",
    cases: 1,
    failure: { type: "AssertionFailedError", message: "expected: <3> but was: <4>" },
  },
  change: { runId: "run-2", exitCode: 0, outcome: "passed", cases: 1, failure: null },
  message: null,
};

describe("the reproduction check in the task panel (ADR-227)", () => {
  test("a reproduced test says Trackwall checked it, and each run says what it found", () => {
    expect(reproductionLabel(CHECK)).toEqual({ tone: "ok", label: "checked by Trackwall: fails without the fix, passes with it" });
    expect(reproductionRunsLine(CHECK)).toBe(
      "Without the fix: failed (AssertionFailedError: expected: <3> but was: <4>) · With the fix: passed",
    );
  });

  test("a running check names its phase, and a run whose reports lack the test says so", () => {
    expect(reproductionLabel({ ...CHECK, state: "running", phase: "base", change: null })).toEqual({
      tone: "warning",
      label: "checking: running the test without the fix",
    });
    const missing: ReproductionCheck = {
      ...CHECK,
      state: "inconclusive",
      base: { runId: "run-1", exitCode: 1, outcome: "missing", cases: 0, failure: null },
      change: null,
    };
    expect(reproductionLabel(missing)).toEqual({ label: "check inconclusive" });
    expect(reproductionRunsLine(missing)).toBe("Without the fix: not in the test reports");
  });

  test("a check that ran every test says why, and one of another test is not this test's", () => {
    expect(reproductionFilterNote({ ...CHECK, filter: null })).toBe("The repo's test task takes no filter, so every test ran.");
    expect(reproductionFilterNote(CHECK)).toBeNull();
    expect(checksTest(CHECK, TEST)).toBe(true);
    expect(checksTest(CHECK, { ...TEST, name: "CartTest#empty" })).toBe(false);
  });

  test("a finished check of an earlier test is not shown, but a running one is, so it can be stopped", () => {
    const later = { ...TEST, name: "CartTest#empty" };
    expect(shownCheck(CHECK, later)).toBeNull();
    expect(shownCheck({ ...CHECK, state: "running", phase: "base" }, later)?.state).toBe("running");
    expect(shownCheck(CHECK, TEST)).toBe(CHECK);
    expect(shownCheck(null, TEST)).toBeNull();
  });
});
