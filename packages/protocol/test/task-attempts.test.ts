import { describe, expect, test } from "bun:test";
import { firstAttempt, otherAttempts } from "../src/task-attempts.ts";

describe("attempts at one task", () => {
  test("a first attempt is its own first attempt, and its retries and their retries go back to it", () => {
    const first = { id: "a", retryOf: null };
    const retry = { id: "b", retryOf: "a" };
    const retryOfRetry = { id: "c", retryOf: "b" };
    const tasks = [first, retry, retryOfRetry];

    expect([first, retry, retryOfRetry].map((t) => firstAttempt(t, tasks))).toEqual(["a", "a", "a"]);
  });

  test("retries of a task that has ended go back to its id, so they stay attempts at one task", () => {
    const tasks = [
      { id: "b", retryOf: "ended" },
      { id: "c", retryOf: "ended" },
    ];

    expect(tasks.map((t) => firstAttempt(t, tasks))).toEqual(["ended", "ended"]);
    expect(otherAttempts({ id: "b", retryOf: "ended" }, tasks)).toEqual([{ id: "c", retryOf: "ended" }]);
  });

  test("the other attempts leave out the task itself and tasks of other first attempts", () => {
    const tasks = [
      { id: "a", retryOf: null },
      { id: "b", retryOf: "a" },
      { id: "other", retryOf: null },
      { id: "c", retryOf: "b" },
    ];

    expect(otherAttempts({ id: "b", retryOf: "a" }, tasks).map((t) => t.id)).toEqual(["a", "c"]);
    expect(otherAttempts({ id: "other", retryOf: null }, tasks)).toEqual([]);
  });

  test("a cycle of retries, which no daemon writes, ends instead of looping", () => {
    const tasks = [
      { id: "a", retryOf: "b" },
      { id: "b", retryOf: "a" },
    ];

    expect(firstAttempt({ id: "a", retryOf: "b" }, tasks)).toBe("a");
  });
});
