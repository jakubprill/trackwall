import { describe, expect, test } from "bun:test";
import { unpushedRows } from "../src/lib/unpushed-work.ts";

const api = { repo: "api", commits: 3, branches: ["feature", "main"], noRemote: false, stashes: 1, changes: 0, changedWorktrees: 0 };

describe("the Home section of work only in this container (ADR-162)", () => {
  test("each repo says what is unpushed, leaving out what is zero, and keeps its branches for the tooltip", () => {
    expect(unpushedRows({ inContainer: true, repos: [api], unreadable: [] })).toEqual([
      { repo: "api", label: "3 commits, 1 stash", branches: ["feature", "main"] },
    ]);
  });

  test("a repo without a remote says so, since all its commits count", () => {
    const notes = { ...api, repo: "notes", commits: 1, stashes: 0, changes: 2, noRemote: true, branches: ["main"] };
    expect(unpushedRows({ inContainer: true, repos: [notes], unreadable: [] })[0]?.label).toBe("1 commit, 2 changed files, no remote");
  });

  test("a repo git cannot read is listed after the others, since its work is unknown", () => {
    expect(unpushedRows({ inContainer: true, repos: [api], unreadable: ["broken"] }).map((r) => [r.repo, r.label])).toEqual([
      ["api", "3 commits, 1 stash"],
      ["broken", "git cannot read it"],
    ]);
  });

  test("outside a container, before the answer and when all is pushed there is nothing to show", () => {
    expect(unpushedRows({ inContainer: false, repos: [api], unreadable: [] })).toEqual([]);
    expect(unpushedRows(undefined)).toEqual([]);
    expect(unpushedRows({ inContainer: true, repos: [], unreadable: [] })).toEqual([]);
  });
});
