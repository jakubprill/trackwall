import { describe, expect, test } from "bun:test";
import type { NewTaskBase, ServerCheckState } from "@trackwall/protocol";
import { newTaskBaseLine, syncedTaskBaseLine } from "../src/lib/new-task-base.ts";

const NOW = new Date("2026-11-22T12:00:00.000Z");
const TWO_HOURS_AGO = "2026-11-22T10:00:00.000Z";
const FOUR_MIN_AGO = "2026-11-22T11:56:00.000Z";

function base(over: Partial<NewTaskBase> = {}): NewTaskBase {
  return { branch: "main", remoteBranch: "origin/main", behind: 0, ahead: 0, fetchedAt: TWO_HOURS_AGO, ...over };
}

/** A round of the server check four minutes ago that found the server past `remoteBranches` of catalog. */
function checked(remoteBranches: string[]): ServerCheckState {
  return {
    on: true,
    last: { endedAt: FOUR_MIN_AGO, newCommits: [{ repo: "catalog", checkedAt: FOUR_MIN_AGO, remoteBranches }], unreached: [] },
  };
}

describe("the line above Create task about where the task starts (ADR-296)", () => {
  test("a default branch behind the remote one as of the last fetch warns that the agent would work on older code, and offers the sync", () => {
    expect(newTaskBaseLine("catalog", base({ behind: 15 }), undefined, NOW)).toEqual({
      tone: "warning",
      text: "main is 15 commits behind origin/main (fetched 2 h ago). The task starts from main, so its agent would work on older code.",
      sync: "Sync main",
    });
  });

  test("new commits the server check found on the default branch warn too, until a fetch after the check brings them", () => {
    expect(newTaskBaseLine("catalog", base(), checked(["origin/main"]), NOW)).toEqual({
      tone: "warning",
      text: "The server has new commits on main that catalog has not fetched (checked 4 min ago). The task would start without them.",
      sync: "Sync main",
    });
    expect(newTaskBaseLine("catalog", base({ fetchedAt: "2026-11-22T11:58:00.000Z" }), checked(["origin/main"]), NOW)).toBeNull();
  });

  test("only the default branch counts: new commits on the branch another checked-out branch tracks say nothing about where a task starts", () => {
    expect(newTaskBaseLine("catalog", base(), checked(["origin/discounts"]), NOW)).toBeNull();
  });

  test("a diverged default branch cannot be synced, so the line only says where the task starts and where to merge", () => {
    expect(newTaskBaseLine("catalog", base({ behind: 15, ahead: 2 }), checked(["origin/main"]), NOW)).toEqual({
      tone: "info",
      text: "main and origin/main have diverged (2 local, 15 remote), so a sync leaves main as it is; merge them in the repo's Shell. The task starts from your main.",
      sync: null,
    });
  });

  test("an up-to-date default branch, unpushed commits on it, or a repo with nothing to compare get no line", () => {
    expect(newTaskBaseLine("catalog", base(), undefined, NOW)).toBeNull();
    expect(newTaskBaseLine("catalog", base({ ahead: 3 }), undefined, NOW)).toBeNull();
    expect(newTaskBaseLine("catalog", null, checked(["origin/main"]), NOW)).toBeNull();
  });

  test("after the sync the line says what it did, as Sync all says it, and a skip stays a warning", () => {
    expect(
      syncedTaskBaseLine({
        state: "updated",
        branch: "main",
        remoteBranch: "origin/main",
        commits: 15,
        workingTree: { branch: "discounts", changed: 0, untracked: 0 },
      }),
    ).toEqual({
      tone: "ok",
      text: "main moved 15 commits forward to origin/main. The working directory is on discounts, so files in the working directory did not change.",
      sync: null,
    });
    expect(
      syncedTaskBaseLine({
        state: "skipped",
        reason: "dirty",
        message: "main is checked out and has uncommitted changes",
        workingTree: { branch: "main", changed: 2, untracked: 0 },
      }),
    ).toEqual({
      tone: "warning",
      text: "main is checked out and has uncommitted changes. Uncommitted files stay as they are: 2 changed.",
      sync: null,
    });
  });
});
