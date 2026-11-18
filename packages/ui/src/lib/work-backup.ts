import {
  countLabel,
  type RestoredBranch,
  type RestoredChanges,
  type RestoredFile,
  type RestoredRepo,
  type RestoredStash,
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

/** One line of a repo's restore, with a key that stays the same while the plan is read again. */
export interface RestoreLine {
  key: string;
  text: string;
}

/** What restoring does to one repo, one line per change; the backup's parts the repo has already are left out. */
export function restoreRepoLines(repo: RestoredRepo): RestoreLine[] {
  if (repo.state === "not-cloned")
    return [{ key: "state", text: `Not in the projects folder: clone ${repo.path} first, then look again.` }];
  if (repo.state === "cannot-restore") return [{ key: "state", text: `Git cannot take it: ${repo.message ?? "no reason given"}` }];
  const lines = [
    ...repo.branches.map((b) => line(`branch:${b.name}`, branchLine(b))),
    ...repo.stashes.map((s, i) => line(`stash:${i}`, stashLine(s))),
    ...repo.changes.map((c) => line(`changes:${c.worktree}`, changesLine(c))),
  ].filter((l) => l !== null);
  return lines.length > 0 ? lines : [{ key: "state", text: "Nothing to restore: the repo has all of it." }];
}

function line(key: string, text: string | null): RestoreLine | null {
  return text === null ? null : { key, text };
}

function stashLine(s: RestoredStash): string | null {
  if (s.action === "add") return `Stash "${s.message}": added to the stash list`;
  return s.action === "missing" ? `Stash "${s.message}": not in the file` : null;
}

function changesLine(c: RestoredChanges): string | null {
  if (c.action === "create") return `Uncommitted changes of ${c.worktree}: on branch ${c.target}`;
  return c.action === "missing" ? `Uncommitted changes of ${c.worktree}: not in the file` : null;
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
