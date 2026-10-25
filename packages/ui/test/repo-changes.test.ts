import { describe, expect, test } from "bun:test";
import { GRAPH_PACE, pollPace, REPO_LIST_PACE, RepoChangeCounter, warmupLabel } from "../src/lib/repo-changes.ts";

describe("repo changes in the UI", () => {
  test("the first snapshot only sets the start, a new revision is a change, and the same one after a reconnect is not", () => {
    const counter = new RepoChangeCounter();
    expect([4, 4, 5, 5, 7].map((revision) => counter.see(revision))).toEqual([0, 0, 1, 1, 2]);
  });

  test("a restarted daemon counts from zero again, and its first different revision is a change", () => {
    const counter = new RepoChangeCounter();
    expect([12, 0, 1].map((revision) => counter.see(revision))).toEqual([0, 1, 2]);
  });

  test("with live repo events the list and the graph poll rarely, without them as often as before the watch", () => {
    expect([pollPace(REPO_LIST_PACE, true), pollPace(REPO_LIST_PACE, false)]).toEqual([30_000, 10_000]);
    expect([pollPace(GRAPH_PACE, true), pollPace(GRAPH_PACE, false)]).toEqual([300_000, 30_000]);
  });

  test("the warm-up says how far it is while it runs, and up to date when it is idle", () => {
    expect(warmupLabel({ running: true, done: 12, total: 80 })).toBe("computing 12 of 80");
    expect(warmupLabel({ running: false, done: 80, total: 80 })).toBe("up to date");
    expect(warmupLabel({ running: false, done: 0, total: 0 })).toBe("up to date");
  });
});
