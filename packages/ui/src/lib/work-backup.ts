import {
  countLabel,
  type RestoredBranch,
  type RestoredFile,
  type RestoredRepo,
  type WorkBackupInfo,
  type WorkBackupRestore,
} from "@trackwall/protocol";
import { formatBytes, relativeTime } from "./format.ts";

/**
 * The work backup in Settings (ADR-275): one line on when the last backup was made, one on what it holds, and the
 * repos it lacks; for an uploaded backup, what restoring it does, repo by repo. Pure functions, tested in `test/work-backup.test.ts`.
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

/** What restoring does to one repo, one line per change; the backup's parts the repo has already are left out. */
export function restoreRepoLines(repo: RestoredRepo): string[] {
  if (repo.state === "not-cloned") return [`Not in the projects folder: clone ${repo.path} first, then look again.`];
  if (repo.state === "cannot-restore") return [`Git cannot take it: ${repo.message ?? "no reason given"}`];
  const lines = [
    ...repo.branches.map(branchLine),
    ...repo.stashes.map((s) =>
      s.action === "add"
        ? `Stash "${s.message}": added to the stash list`
        : s.action === "missing"
          ? `Stash "${s.message}": not in the file`
          : null,
    ),
    ...repo.changes.map((c) =>
      c.action === "create"
        ? `Uncommitted changes of ${c.worktree}: on branch ${c.target}`
        : c.action === "missing"
          ? `Uncommitted changes of ${c.worktree}: not in the file`
          : null,
    ),
  ].filter((line) => line !== null);
  return lines.length > 0 ? lines : ["Nothing to restore: the repo has all of it."];
}

function branchLine(b: RestoredBranch): string | null {
  switch (b.action) {
    case "create":
      return `${b.name}: new branch`;
    case "fast-forward":
      return `${b.name}: moves forward to the backup's commit`;
    case "side-branch":
      return `${b.name}: yours went another way and stays; the backup's commit goes to ${b.target}`;
    case "missing":
      return `${b.name}: its commit is neither in the file nor in this clone; fetch, then look again`;
    case "unchanged":
      return null;
  }
}

/** One line per `.trackwall` file that a restore makes or leaves alone because yours differs. */
export function restoreFileLines(files: readonly RestoredFile[]): string[] {
  return files.flatMap((f) =>
    f.action === "create" ? [`${f.path}: made`] : f.action === "kept-yours" ? [`${f.path}: yours differs and stays`] : [],
  );
}

/** How many branches, stashes, changes and files a restore would add or move: what the Restore button would do. */
export function restoreChanges(plan: WorkBackupRestore): number {
  const ready = plan.repos.filter((r) => r.state === "ready");
  return (
    ready.reduce(
      (n, r) =>
        n +
        r.branches.filter((b) => b.action !== "unchanged" && b.action !== "missing").length +
        r.stashes.filter((s) => s.action === "add").length +
        r.changes.filter((c) => c.action === "create").length,
      0,
    ) + plan.files.filter((f) => f.action === "create").length
  );
}

/** "4 changes to restore" or "Nothing left to restore". */
export function restoreSummary(plan: WorkBackupRestore): string {
  const count = restoreChanges(plan);
  return count === 0 ? "Nothing left to restore" : `${countLabel(count, { one: "change", other: "changes" })} to restore`;
}
