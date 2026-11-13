import { describe, expect, test } from "bun:test";
import { refreshMessage } from "../src/lib/task-refresh.ts";

const BASE = "a".repeat(40);

describe("the message after Refresh from the base branch (ADR-244)", () => {
  test("a refresh that merged commits says how many and from where, and that the agent is told", () => {
    expect(refreshMessage({ state: "refreshed", from: "origin/main", commits: 3, base: BASE })).toEqual({
      tone: "done",
      text: "Merged 3 commits from origin/main. The agent is told to read the changed files again.",
    });
  });

  test("a task that has everything already says so", () => {
    expect(refreshMessage({ state: "up-to-date", from: "main" })).toEqual({ tone: "done", text: "Already up to date with main." });
  });

  test("a merge that would conflict names the files, says nothing changed, and what to do", () => {
    expect(refreshMessage({ state: "conflicts", from: "origin/main", commits: 1, files: ["README.md", "src/app.ts"] })).toEqual({
      tone: "warning",
      text:
        "Not refreshed: merging 1 commit from origin/main would conflict in README.md, src/app.ts. " +
        "Nothing was changed; you can ask the agent to merge origin/main and resolve the conflicts.",
    });
  });
});
