import { describe, expect, test } from "bun:test";
import type { Verification } from "@trackwall/protocol";
import { offersRetry, oneClickRetryModel } from "../src/lib/task-retry.ts";

function verification(state: Verification["state"]): Pick<Verification, "state"> {
  return { state };
}

describe("retrying a failed task on a stronger model", () => {
  test("only a failed verification offers the retry", () => {
    const task = { change: null };
    expect(offersRetry(task, verification("failed"))).toBe(true);
    expect(offersRetry(task, verification("passed"))).toBe(false);
    expect(offersRetry(task, verification("running"))).toBe(false);
    expect(offersRetry(task, verification("cancelled"))).toBe(false);
    expect(offersRetry(task, null)).toBe(false);
  });

  test("a part of a change is not offered the retry, even when its verification failed", () => {
    expect(offersRetry({ change: { id: "c0ffee00-0000-4000-8000-000000000000", position: 0 } }, verification("failed"))).toBe(false);
  });

  test("the retry model from Settings is the one-click model of a task on another one", () => {
    expect(oneClickRetryModel({ model: "gpt-5-mini" }, "claude-opus-5.5")).toBe("claude-opus-5.5");
    expect(oneClickRetryModel({ model: null }, "claude-opus-5.5")).toBe("claude-opus-5.5");
  });

  test("a task already on the retry model, or no retry model, leaves the model to the user", () => {
    expect(oneClickRetryModel({ model: "claude-opus-5.5" }, "claude-opus-5.5")).toBeNull();
    expect(oneClickRetryModel({ model: "gpt-5-mini" }, null)).toBeNull();
  });
});
