import { describe, expect, test } from "bun:test";
import type { TaskWorktree } from "@trackwall/protocol";
import { cleanupCandidates, initiallySelected, lossLabel, lossyTasks, removable, removeRequest } from "../src/lib/worktree-cleanup.ts";

const NOW = new Date("2026-11-04T12:00:00.000Z");
const FINGERPRINT = "a".repeat(64);

function worktree(task: string, lastActivityAt: string, loss: TaskWorktree["loss"] = { kind: "none" }): TaskWorktree {
  return { task, repo: "shop", branch: `trackwall/${task}`, lastActivityAt, loss };
}

describe("the cleanup of old task worktrees (ADR-210)", () => {
  test("offers the tasks idle for at least the chosen days, the longest idle first", () => {
    const list = [
      worktree("yesterday", "2026-11-03T12:00:00.000Z"),
      worktree("last-month", "2026-10-01T12:00:00.000Z"),
      worktree("a-week-ago", "2026-10-28T12:00:00.000Z"),
    ];

    expect(cleanupCandidates(list, 7, NOW).map((w) => w.task)).toEqual(["last-month", "a-week-ago"]);
    expect(cleanupCandidates(list, 1, NOW).map((w) => w.task)).toEqual(["last-month", "a-week-ago", "yesterday"]);
  });

  test("says what ending a task would delete, and leaves a task whose loss could not be read to its own End task", () => {
    const clean = worktree("clean", "2026-10-01T12:00:00.000Z");
    const dirty = worktree("dirty", "2026-10-01T12:00:00.000Z", {
      kind: "work",
      uncommitted: 3,
      strayCommits: 1,
      fingerprint: FINGERPRINT,
    });
    const unread = worktree("unread", "2026-10-01T12:00:00.000Z", { kind: "unknown", reason: "the repo is gone" });

    expect(lossLabel(clean)).toBeNull();
    expect(lossLabel(dirty)).toBe("3 uncommitted changes, 1 commit outside the branch");
    expect(lossLabel(unread)).toBe("what would be lost could not be read (the repo is gone)");
    expect([clean, dirty, unread].map(removable)).toEqual([true, true, false]);
  });

  test("chooses at the start only the tasks that lose nothing, and names the chosen ones that would lose work", () => {
    const clean = worktree("clean", "2026-10-01T12:00:00.000Z");
    const dirty = worktree("dirty", "2026-10-01T12:00:00.000Z", {
      kind: "work",
      uncommitted: 2,
      strayCommits: 0,
      fingerprint: FINGERPRINT,
    });

    expect([...initiallySelected([clean, dirty])]).toEqual(["clean"]);
    expect(lossyTasks([clean, dirty], new Set(["clean"]))).toEqual([]);
    expect(lossyTasks([clean, dirty], new Set(["clean", "dirty"])).map((w) => w.task)).toEqual(["dirty"]);
  });

  test("ends a clean task without discarding anything, and a confirmed one only while its worktree is what the user saw", () => {
    const clean = worktree("clean", "2026-10-01T12:00:00.000Z");
    const dirty = worktree("dirty", "2026-10-01T12:00:00.000Z", {
      kind: "work",
      uncommitted: 2,
      strayCommits: 0,
      fingerprint: FINGERPRINT,
    });

    expect(removeRequest(clean)).toEqual({ task: "clean", keepBranch: true, discardChanges: false });
    expect(removeRequest(dirty)).toEqual({ task: "dirty", keepBranch: true, discardChanges: true, discardFingerprint: FINGERPRINT });
  });
});
