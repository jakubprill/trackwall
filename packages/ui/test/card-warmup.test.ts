import { describe, expect, test } from "bun:test";
import { graphLoadingText, warmupLabel } from "../src/lib/card-warmup.ts";

describe("the card warm-up in the UI", () => {
  test("the Daemon panel says how far the warm-up is while it runs, and up to date when it is idle", () => {
    expect(warmupLabel({ running: true, done: 12, total: 80 })).toBe("computing 12 of 80");
    expect(warmupLabel({ running: false, done: 80, total: 80 })).toBe("up to date");
  });

  test("Overview adds the progress to its loading text only while the warm-up runs", () => {
    expect(graphLoadingText({ running: true, done: 3, total: 9 })).toBe("Building the graph from repo cards, computing 3 of 9…");
    expect(graphLoadingText({ running: false, done: 9, total: 9 })).toBe("Building the graph from repo cards…");
    expect(graphLoadingText(undefined)).toBe("Building the graph from repo cards…");
  });
});
