import { describe, expect, test } from "bun:test";
import { currentRun } from "../src/lib/background-run.ts";

type Run = { startedAt: string; finishedAt: string | null };

const before: Run = { startedAt: "2026-10-23T10:00:00Z", finishedAt: "2026-10-23T10:01:00Z" };
const started: Run = { startedAt: "2026-10-23T11:00:00Z", finishedAt: null };

describe("background run in the UI", () => {
  test("without an action the result of polling is shown", () => {
    expect(currentRun(undefined, { data: before, loadNumber: 3 })).toBe(before);
    expect(currentRun(undefined, {})).toBeUndefined();
  });

  test("the action result wins over the answer to a request sent before the action, also one that arrived after it", () => {
    const acted = { run: started, afterLoad: 5 };
    expect(currentRun(acted, { data: before, loadNumber: 4 })).toBe(started);
    expect(currentRun(acted, { data: before, loadNumber: 5 })).toBe(started);
    expect(currentRun(acted, { data: null, loadNumber: 5 })).toBe(started);
  });

  test("the first answer to a request sent after the action replaces its result, also an empty one after a daemon restart", () => {
    const acted = { run: started, afterLoad: 5 };
    const fresh: Run = { ...started, finishedAt: "2026-10-23T11:00:05Z" };
    expect(currentRun(acted, { data: fresh, loadNumber: 6 })).toBe(fresh);
    expect(currentRun(acted, { data: null, loadNumber: 6 })).toBeNull();
  });

  test("an action's answer of false is shown like any other until a fresh read lands", () => {
    const answered = { run: false, afterLoad: 2 };
    expect(currentRun(answered, { data: true, loadNumber: 2 })).toBe(false);
    expect(currentRun(answered, { data: true, loadNumber: 3 })).toBe(true);
  });
});
