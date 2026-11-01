import { describe, expect, test } from "bun:test";
import { unpushedSummary, unpushedTotal } from "../src/unpushed-work.ts";

describe("unpushed work in words (ADR-162)", () => {
  test("names each part with its count and leaves out what is zero", () => {
    expect(unpushedSummary({ commits: 2, changes: 1, stashes: 3 })).toBe("2 commits, 1 changed file, 3 stashes");
    expect(unpushedSummary({ commits: 0, changes: 5, stashes: 1 })).toBe("5 changed files, 1 stash");
    expect(unpushedSummary({ commits: 1, changes: 0, stashes: 0 })).toBe("1 commit");
  });

  test("the folder's total adds the repos up", () => {
    expect(
      unpushedTotal([
        { commits: 2, changes: 1, stashes: 0 },
        { commits: 1, changes: 0, stashes: 2 },
      ]),
    ).toEqual({ commits: 3, changes: 1, stashes: 2 });
    expect(unpushedTotal([])).toEqual({ commits: 0, changes: 0, stashes: 0 });
  });
});
