import { describe, expect, test } from "bun:test";
import type { RepoStatus } from "@trackwall/protocol";
import { branchLabel, listNeedsSettings, repoStatusTone } from "../src/lib/repo-status.ts";

const ok = { kind: "ok", branch: "main", head: null, upstream: null, untracked: 0 } as const;

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

describe("repo list to fix in the settings", () => {
  test("the projects folder to fix in the settings: it disappeared or workspace.yaml is bad", () => {
    expect(listNeedsSettings("projects_dir_unavailable")).toBe(true);
    expect(listNeedsSettings("invalid_config")).toBe(true);
    expect(listNeedsSettings("not_found")).toBe(false);
    expect(listNeedsSettings(undefined)).toBe(false);
  });
});
