import { describe, expect, test } from "bun:test";
import { type HandoffGit, handoffState } from "../src/modules/agents/task-handoff.ts";

const handoff = {
  task: "5e7a1c3b-0000-4000-8000-000000000000",
  repo: "payments",
  branch: "trackwall/retry-5e7a1c",
  commit: "a".repeat(40),
};

describe("where the work a task builds on is now (get_handoff, ADR-144)", () => {
  test("an ended handing task has no head to compare, so nothing reads git", async () => {
    const git: HandoffGit = {
      countBetween: () => Promise.reject(new Error("no git expected")),
      changedPathsBetween: () => Promise.reject(new Error("no git expected")),
    };
    expect(await handoffState(handoff, undefined, git)).toEqual({
      task: handoff.task,
      repo: "payments",
      branch: "trackwall/retry-5e7a1c",
      ended: true,
      read: "a".repeat(40),
      head: null,
      commits: null,
      files: [],
      filesTruncated: false,
    });
  });

  test("a read commit gone after a rewritten history gives the head with the commits and files unknown", async () => {
    const git: HandoffGit = {
      countBetween: async () => undefined,
      changedPathsBetween: async () => undefined,
    };
    expect(await handoffState(handoff, { worktree: "/worktrees/payments/retry", head: "b".repeat(40) }, git)).toMatchObject({
      ended: false,
      read: "a".repeat(40),
      head: "b".repeat(40),
      commits: null,
      files: [],
      filesTruncated: false,
    });
  });

  test("more changed files than the limit are cut and say so", async () => {
    const git: HandoffGit = {
      countBetween: async () => 3,
      changedPathsBetween: async (_dir, _from, _to, max) => ({
        paths: Array.from({ length: max }, (_, i) => `f${i}.java`),
        truncated: true,
      }),
    };
    const state = await handoffState(handoff, { worktree: "/worktrees/payments/retry", head: "b".repeat(40) }, git);
    expect(state.commits).toBe(3);
    expect(state.files).toHaveLength(100);
    expect(state.filesTruncated).toBe(true);
  });
});
