import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type KnownPlaces, type KnownTask, workPlace } from "../src/modules/usage-report/work-place.ts";

const root = join("/", "work");
const projects = join(root, "projects");
const worktrees = join(projects, ".trackwall", "worktrees");

const task = (t: Partial<KnownTask> & Pick<KnownTask, "id" | "repo">): KnownTask => ({
  branch: "trackwall/fix-login-3f2a9c",
  worktree: join(worktrees, t.repo, "fix-login-3f2a9c"),
  title: null,
  prompt: "Fix the login\nand its test",
  ...t,
});

const known = (tasks: KnownTask[]): KnownPlaces => ({
  tasks,
  repos: [
    { id: "shop", path: join(projects, "shop") },
    { id: "billing", path: join(projects, "billing") },
  ],
  projectsDir: projects,
  isTaskBranch: (branch) => branch.startsWith("trackwall/"),
});

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

describe("the work a Copilot CLI conversation was for, from its folder and branch (ADR-195)", () => {
  test("a task by its worktree, named by its title or the first line of its prompt", () => {
    const cwd = join(worktrees, "shop", "fix-login-3f2a9c");
    const tasks = [task({ id: T1, repo: "shop", worktree: cwd, title: "Fix the login" })];

    expect(workPlace({ cwd, branch: "trackwall/fix-login-3f2a9c" }, known(tasks))).toEqual({
      kind: "task",
      task: T1,
      repo: "shop",
      label: "Fix the login",
    });
    expect(workPlace({ cwd, branch: "trackwall/fix-login-3f2a9c" }, known([task({ id: T1, repo: "shop", title: null })])).label).toBe(
      "Fix the login",
    );
  });

  test("the parts of a change share a branch, so each is found by its worktree", () => {
    const tasks = [task({ id: T1, repo: "shop" }), task({ id: T2, repo: "billing" })];

    const place = workPlace({ cwd: join(worktrees, "billing", "fix-login-3f2a9c"), branch: "trackwall/fix-login-3f2a9c" }, known(tasks));

    expect(place).toMatchObject({ kind: "task", task: T2, repo: "billing" });
  });

  test("a worktree that moved since is found by its repo folder, then by its branch when one task has it, and is not guessed among several", () => {
    const moved = { cwd: join(root, "old-worktrees", "shop", "fix-login-3f2a9c"), branch: "trackwall/fix-login-3f2a9c" };
    const elsewhere = { cwd: join(root, "old-worktrees", "web", "fix-login-3f2a9c"), branch: "trackwall/fix-login-3f2a9c" };

    expect(workPlace(moved, known([task({ id: T1, repo: "shop" }), task({ id: T2, repo: "billing" })]))).toMatchObject({ task: T1 });
    expect(workPlace(elsewhere, known([task({ id: T1, repo: "shop", worktree: null })]))).toMatchObject({ kind: "task", task: T1 });
    expect(workPlace(elsewhere, known([task({ id: T1, repo: "shop" }), task({ id: T2, repo: "billing" })]))).toEqual({
      kind: "task",
      task: null,
      repo: null,
      label: "trackwall/fix-login-3f2a9c",
    });
  });

  test("a task branch Trackwall no longer knows is a task named by its branch", () => {
    expect(workPlace({ cwd: join(worktrees, "shop", "old-work-a1b2c3"), branch: "trackwall/old-work-a1b2c3" }, known([]))).toEqual({
      kind: "task",
      task: null,
      repo: null,
      label: "trackwall/old-work-a1b2c3",
    });
  });

  test("the projects folder is the supervisor's, a repo's folder or one inside it is that repo's, the rest is outside", () => {
    expect(workPlace({ cwd: projects }, known([]))).toMatchObject({ kind: "supervisor", task: null, repo: null });
    expect(workPlace({ cwd: join(projects, "shop"), branch: "main" }, known([]))).toMatchObject({ kind: "repo", repo: "shop" });
    expect(workPlace({ cwd: join(projects, "billing", "src"), branch: "main" }, known([]))).toMatchObject({
      kind: "repo",
      repo: "billing",
    });
    expect(workPlace({ cwd: join(root, "notes"), branch: "main" }, known([]))).toMatchObject({ kind: "outside" });
    expect(workPlace({}, known([]))).toMatchObject({ kind: "outside" });
  });
});
