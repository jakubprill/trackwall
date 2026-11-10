import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { TaskBranchPrefix } from "@trackwall/protocol";
import { isTaskBranchUnder, TaskBranch, taskSlug, taskWorktree } from "../src/modules/agents/task-branch.ts";

const ID = "3f2a9c1e-0000-4000-8000-000000000000";

describe("task branch name from the prompt", () => {
  test("the first words of the prompt without diacritics and the start of the identifier", () => {
    expect(taskSlug("Fix the naïve Łódź façade login button", ID)).toBe("fix-the-naive-lodz-facade-login-3f2a9c");
  });

  test("characters other than letters and digits only separate words, and a prompt without letters and digits gives a fallback name", () => {
    expect(taskSlug("--yolo: fix #42 (urgent!)", ID)).toBe("yolo-fix-42-urgent-3f2a9c");
    expect(taskSlug("??? 🚀", ID)).toBe("task-3f2a9c");
  });

  test("a first word longer than the limit is cut, not lost", () => {
    expect(taskSlug("a".repeat(50), ID)).toBe(`${"a".repeat(32)}-3f2a9c`);
  });
});

describe("task branch prefix (ADR-239)", () => {
  test("a prefix is one to three folders ending with /, and nothing a git branch or a folder name cannot carry", () => {
    expect(TaskBranchPrefix.safeParse("trackwall/").success).toBe(true);
    expect(TaskBranchPrefix.safeParse("feature/").success).toBe(true);
    expect(TaskBranchPrefix.safeParse("users/JD_dev/agents/").success).toBe(true);
    expect(TaskBranchPrefix.safeParse("feature").success).toBe(false);
    expect(TaskBranchPrefix.safeParse("").success).toBe(false);
    expect(TaskBranchPrefix.safeParse("a/b/c/d/").success).toBe(false);
    expect(TaskBranchPrefix.safeParse("-x/").success).toBe(false);
    expect(TaskBranchPrefix.safeParse("../").success).toBe(false);
    expect(TaskBranchPrefix.safeParse("feature\\").success).toBe(false);
    expect(TaskBranchPrefix.safeParse("my feature/").success).toBe(false);
  });

  test("a saved task branch has any such prefix, but never names a branch without a folder", () => {
    expect(TaskBranch.safeParse("trackwall/fix-login-3f2a9c").success).toBe(true);
    expect(TaskBranch.safeParse("feature/fix-login-3f2a9c").success).toBe(true);
    expect(TaskBranch.safeParse("main").success).toBe(false);
    expect(TaskBranch.safeParse("feature/Fix-login").success).toBe(false);
  });

  test("a branch is an unknown task's only under a prefix Trackwall gives, so a branch the user named stays theirs", () => {
    const prefixes = ["trackwall/", "feature/agents/"];
    expect(isTaskBranchUnder("trackwall/fix-login-3f2a9c", prefixes)).toBe(true);
    expect(isTaskBranchUnder("feature/agents/fix-login-3f2a9c", prefixes)).toBe(true);
    expect(isTaskBranchUnder("feature/login", prefixes)).toBe(false);
    expect(isTaskBranchUnder("trackwall/more/fix-login-3f2a9c", prefixes)).toBe(false);
  });

  test("the worktree takes only the part of the branch after its last /", () => {
    expect(taskWorktree(join("w"), "shop", "trackwall/fix-login-3f2a9c")).toBe(join("w", "shop", "fix-login-3f2a9c"));
    expect(taskWorktree(join("w"), "shop", "users/me/fix-login-3f2a9c")).toBe(join("w", "shop", "fix-login-3f2a9c"));
  });
});
