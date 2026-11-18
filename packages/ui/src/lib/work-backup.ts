import { countLabel, type WorkBackupInfo } from "@trackwall/protocol";
import { formatBytes, relativeTime } from "./format.ts";

/**
 * The work backup in Settings (ADR-275): one line on when the last backup was made, one on what it holds, and the
 * repos it lacks. Pure functions, tested in `test/work-backup.test.ts`.
 */

/** "Made 2 h ago, 412.0 KB" */
export function workBackupWhen(info: WorkBackupInfo, now: Date): string {
  return `Made ${relativeTime(info.createdAt, now)}, ${formatBytes(info.bytes)}`;
}

/** "3 repos, 5 branches, 2 stashes, 1 worktree with uncommitted changes, 4 Trackwall files", leaving out what is zero. */
export function workBackupContents(info: WorkBackupInfo): string {
  const parts = [
    countLabel(info.repos, { one: "repo", other: "repos" }),
    info.branches > 0 ? countLabel(info.branches, { one: "branch", other: "branches" }) : null,
    info.stashes > 0 ? countLabel(info.stashes, { one: "stash", other: "stashes" }) : null,
    info.changedWorktrees > 0
      ? countLabel(info.changedWorktrees, { one: "worktree with uncommitted changes", other: "worktrees with uncommitted changes" })
      : null,
    info.stateFiles > 0 ? countLabel(info.stateFiles, { one: "Trackwall file", other: "Trackwall files" }) : null,
  ];
  return parts.filter((part) => part !== null).join(", ");
}
