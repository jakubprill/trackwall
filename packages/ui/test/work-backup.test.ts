import { describe, expect, test } from "bun:test";
import type { RestoredRepo, WorkBackupInfo, WorkBackupRestore } from "@trackwall/protocol";
import { restoreFileLines, restoreRepoLines, restoreSummary, workBackupContents, workBackupWhen } from "../src/lib/work-backup.ts";

const BACKUP: WorkBackupInfo = {
  fileName: "trackwall-backup-2026-11-18-1440.tar.gz",
  createdAt: "2026-11-18T14:40:00.000Z",
  bytes: 421_888,
  repos: 3,
  branches: 5,
  stashes: 1,
  changedWorktrees: 2,
  stateFiles: 4,
  skipped: [],
};

describe("the work backup in Settings", () => {
  test("says when the backup was made and how large it is", () => {
    expect(workBackupWhen(BACKUP, new Date("2026-11-18T16:40:00.000Z"))).toBe("Made 2 h ago, 412.0 KB");
  });

  test("names what the backup holds and leaves out what it has none of", () => {
    expect(workBackupContents(BACKUP)).toBe("3 repos, 5 branches, 1 stash, 2 worktrees with uncommitted changes, 4 Trackwall files");
    expect(workBackupContents({ ...BACKUP, repos: 0, branches: 0, stashes: 0, changedWorktrees: 0, stateFiles: 2 })).toBe(
      "0 repos, 2 Trackwall files",
    );
  });
});

const API: RestoredRepo = {
  repo: "api",
  path: "api",
  state: "ready",
  message: null,
  remotes: [],
  branches: [
    { name: "main", commit: "a1", action: "fast-forward", target: "main", worktree: "/projects/api" },
    { name: "feature", commit: "b2", action: "create", target: "feature", worktree: null },
    { name: "spike", commit: "c3", action: "side-branch", target: "restored/spike", worktree: null },
    { name: "old", commit: "d4", action: "unchanged", target: "old", worktree: null },
  ],
  stashes: [{ message: "On main: half a README", commit: "e5", action: "add" }],
  changes: [{ worktree: "/worktrees/task-7", commit: "f6", action: "create", target: "restored/changes/task-7" }],
};

describe("restoring a work backup in Settings", () => {
  test("names each change a restore makes to a repo and leaves out what the repo has", () => {
    expect(restoreRepoLines(API).map((l) => l.text)).toEqual([
      "main: moves forward to the backup's commit",
      "feature: new branch",
      "spike: yours went another way and stays; the backup's commit goes to restored/spike",
      'Stash "On main: half a README": added to the stash list',
      "Uncommitted changes of /worktrees/task-7: on branch restored/changes/task-7",
    ]);
  });

  test("a repo that is not cloned or that git refuses says what to do instead", () => {
    expect(restoreRepoLines({ ...API, state: "not-cloned" }).map((l) => l.text)).toEqual([
      "Not in the projects folder: clone api first, then look again.",
    ]);
    expect(
      restoreRepoLines({ ...API, state: "cannot-restore", message: "fatal: Repository lacks these prerequisite commits" }).map(
        (l) => l.text,
      ),
    ).toEqual(["Git cannot take it: fatal: Repository lacks these prerequisite commits"]);
  });

  test("counts what the Restore button would do, without repos it cannot reach", () => {
    const plan: WorkBackupRestore = {
      createdAt: "2026-11-18T14:40:00.000Z",
      version: "0.5.29",
      repos: [API, { ...API, repo: "web", state: "not-cloned" }],
      files: [
        { path: ".trackwall/board/launch.md", action: "create" },
        { path: ".trackwall/knowledge/api.md", action: "kept-yours" },
      ],
      stateFilesKept: 2,
    };

    expect(restoreSummary(plan)).toBe("6 changes to restore");
    expect(restoreFileLines(plan.files)).toEqual([
      ".trackwall/board/launch.md: made",
      ".trackwall/knowledge/api.md: yours differs and stays",
    ]);
    expect(restoreSummary({ ...plan, repos: [], files: [] })).toBe("Nothing left to restore");
  });
});
