import { describe, expect, test } from "bun:test";
import type { TestFailure, Verification } from "@trackwall/protocol";
import { failedTestName, testCountsLabel, verificationDuration, verificationLabel, verificationPollMs } from "../src/lib/verification.ts";

const verification = (state: Verification["state"], finishedAt: string | null = null): Verification => ({
  task: "t1",
  repo: "shop",
  miseTask: "test",
  state,
  runId: "r1",
  startedAt: "2026-10-25T10:00:00.000Z",
  finishedAt,
  exitCode: null,
  message: null,
  tests: null,
  failures: [],
  errors: [],
  lastLines: [],
});
const failure = (className: string | null, name: string, suite = "shop.CartTest"): TestFailure => ({
  report: "TEST-shop.CartTest.xml",
  suite,
  className,
  name,
  kind: "failure",
  type: null,
  message: null,
  lines: [],
  omittedLines: 0,
  timeSeconds: null,
});

describe("verification in the task panel", () => {
  test("the verdict is a state with a tone, and a cancel has none", () => {
    expect(verificationLabel(verification("passed"))).toEqual({ tone: "ok", label: "passed" });
    expect(verificationLabel(verification("failed"))).toEqual({ tone: "error", label: "failed" });
    expect(verificationLabel(verification("running"))).toEqual({ tone: "warning", label: "running" });
    expect(verificationLabel(verification("cancelled"))).toEqual({ label: "cancelled" });
  });

  test("a running verification is polled every second, otherwise every five", () => {
    expect(verificationPollMs(verification("running"))).toBe(1000);
    expect(verificationPollMs(verification("passed"))).toBe(5000);
    expect(verificationPollMs(null)).toBe(5000);
  });

  test("the test counts leave out what is zero", () => {
    expect(testCountsLabel({ tests: 1, failures: 0, errors: 0, skipped: 0, timeSeconds: null })).toBe("1 test");
    expect(testCountsLabel({ tests: 128, failures: 2, errors: 1, skipped: 3, timeSeconds: 4 })).toBe(
      "128 tests · 2 failed · 1 error · 3 skipped",
    );
  });

  test("the duration is seconds under a minute, minutes and seconds above, and none while running", () => {
    expect(verificationDuration(verification("passed", "2026-10-25T10:00:41.400Z"))).toBe("41 s");
    expect(verificationDuration(verification("failed", "2026-10-25T10:02:05.000Z"))).toBe("2 min 5 s");
    expect(verificationDuration(verification("running"))).toBeNull();
  });

  test("a failed test is its class without the package and its name", () => {
    expect(failedTestName(failure("shop.CartTest", "sums"))).toBe("CartTest › sums");
    expect(failedTestName(failure(null, "adds two items", "cart.test.ts"))).toBe("cart.test.ts › adds two items");
    expect(failedTestName(failure("rejects an empty cart", "rejects an empty cart"))).toBe("rejects an empty cart");
  });
});
