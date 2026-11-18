import { describe, expect, test } from "bun:test";
import type { WorkBackupInfo } from "@trackwall/protocol";
import { workBackupContents, workBackupWhen } from "../src/lib/work-backup.ts";

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
