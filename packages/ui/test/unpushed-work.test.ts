import { describe, expect, test } from "bun:test";
import { unpushedRows } from "../src/lib/unpushed-work.ts";

const api = { repo: "api", commits: 3, branches: ["feature", "main"], noRemote: false, stashes: 1, changes: 0, changedWorktrees: 0 };

describe("the Home section of work only in this container (ADR-162)", () => {
  test("each repo says what is unpushed, leaving out what is zero, and keeps its branches for the tooltip", () => {
    expect(unpushedRows({ inContainer: true, repos: [api], unreadable: [] })).toEqual([
      { repo: "api", label: "3 commits, 1 stash", detail: "Branches: feature, main" },
    ]);
  });

  test("a repo without a remote says so, since all its commits count", () => {
    const notes = { ...api, repo: "notes", commits: 1, stashes: 0, changes: 2, noRemote: true, branches: ["main"] };
    expect(unpushedRows({ inContainer: true, repos: [notes], unreadable: [] })[0]?.label).toBe("1 commit, 2 changed files, no remote");
  });

  test("a repo git cannot read is listed after the others with git's message, since its work is unknown", () => {
    const work = { inContainer: true, repos: [api], unreadable: [{ repo: "broken", message: "not a git repository" }] };
    expect(unpushedRows(work).map((r) => [r.repo, r.label, r.detail])).toEqual([
      ["api", "3 commits, 1 stash", "Branches: feature, main"],
      ["broken", "git cannot read it", "not a git repository"],
    ]);
  });

  test("before the answer and when all is pushed there is nothing to show", () => {
    expect(unpushedRows(undefined)).toEqual([]);
    expect(unpushedRows({ inContainer: true, repos: [], unreadable: [] })).toEqual([]);
  });
});
