import { describe, expect, test } from "bun:test";
import type { RepoStatus } from "@trackwall/protocol";
import { branchLabel, listNeedsSettings, repoListTone, repoStatusTone, serverLabel } from "../src/lib/repo-status.ts";

const ok = { kind: "ok", branch: "main", head: null, upstream: null, untracked: 0, fetchedAt: null } as const;

describe("repo state in the UI", () => {
  test("a clean repo has tone ok, a repo with changes tone warning with changed and new files separately, an unavailable one tone error, a loading one no tone", () => {
    const statuses: RepoStatus[] = [
      { ...ok, changes: 0 },
      { ...ok, changes: 3 },
      { ...ok, changes: 4, untracked: 1 },
      { ...ok, changes: 2, untracked: 2 },
      { kind: "unavailable", message: "no directory" },
      { kind: "loading" },
    ];
    expect(statuses.map(repoStatusTone)).toEqual([
      { tone: "ok", label: "clean" },
      { tone: "warning", label: "3 changed" },
      { tone: "warning", label: "3 changed, 1 new" },
      { tone: "warning", label: "2 new" },
      { tone: "error", label: "unavailable" },
      { label: "loading" },
    ]);
  });

  test("a branch shows its name, and without a branch the label “detached HEAD”", () => {
    expect([branchLabel({ ...ok, changes: 0 }), branchLabel({ ...ok, branch: null, changes: 0 })]).toEqual(["main", "detached HEAD"]);
  });
});

describe("repo state in the repo list (ADR-291)", () => {
  const behind = (count: number, ahead = 0) => ({ name: "origin/main", ahead, behind: count });

  test("a clean repo whose branch lacks commits of the branch it tracks no longer reads “clean”, and one with changes says both", () => {
    const statuses: RepoStatus[] = [
      { ...ok, changes: 0, upstream: behind(15) },
      { ...ok, changes: 2, upstream: behind(15) },
      { ...ok, changes: 0, upstream: behind(3, 2) },
      { ...ok, changes: 0, upstream: behind(0, 4) },
      { ...ok, changes: 0, upstream: null },
    ];
    expect(statuses.map(repoListTone)).toEqual([
      { tone: "warning", label: "15 to pull" },
      { tone: "warning", label: "2 changed · 15 to pull" },
      { tone: "warning", label: "diverged" },
      { tone: "ok", label: "clean" },
      { tone: "ok", label: "clean" },
    ]);
  });

  test("an unavailable or loading repo reads as in the repo header", () => {
    expect([repoListTone({ kind: "unavailable", message: "no directory" }), repoListTone({ kind: "loading" })]).toEqual([
      { tone: "error", label: "unavailable" },
      { label: "loading" },
    ]);
  });

  test("the server part alone: commits to pull, “diverged” when the branch has its own too, nothing when it lacks none or tracks none", () => {
    expect([
      serverLabel({ ...ok, changes: 0, upstream: behind(1) }),
      serverLabel({ ...ok, changes: 0, upstream: behind(1, 1) }),
      serverLabel({ ...ok, changes: 0, upstream: behind(0, 1) }),
      serverLabel({ ...ok, changes: 0, upstream: null }),
    ]).toEqual(["1 to pull", "diverged", null, null]);
  });
});

describe("repo list to fix in the settings", () => {
  test("the projects folder to fix in the settings: it disappeared or workspace.yaml is bad", () => {
    expect(listNeedsSettings("projects_dir_unavailable")).toBe(true);
    expect(listNeedsSettings("invalid_config")).toBe(true);
    expect(listNeedsSettings("not_found")).toBe(false);
    expect(listNeedsSettings(undefined)).toBe(false);
  });
});
