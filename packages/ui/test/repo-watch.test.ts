import { describe, expect, test } from "bun:test";
import { RepoChangeCounter } from "../src/lib/repo-watch.ts";

const STARTED = "2026-10-25T18:00:00.000Z";
const RESTARTED = "2026-10-25T19:00:00.000Z";

describe("repo changes in the UI", () => {
  test("the first snapshot only sets the start, a new revision is a change, and the same one after a reconnect is not", () => {
    const counter = new RepoChangeCounter();
    const counts = [4, 4, 5, 5, 7].map((revision) => counter.see({ startedAt: STARTED, revision }));
    expect(counts).toEqual([0, 0, 1, 1, 2]);
  });

  test("a restarted daemon is a change even when it reaches the same revision", () => {
    const counter = new RepoChangeCounter();
    counter.see({ startedAt: STARTED, revision: 0 });
    expect(counter.see({ startedAt: RESTARTED, revision: 0 })).toBe(1);
  });
});
