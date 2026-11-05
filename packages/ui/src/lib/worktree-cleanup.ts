import { countLabel, type TaskWorktree } from "@trackwall/protocol";

/**
 * The cleanup of old task worktrees (ADR-210): which tasks it offers and what ending each one would delete. It ends a
 * task as "End task" does with the branch kept, so the task's commits stay; work in no commit is deleted only for a task
 * the user confirmed, and only while its worktree still holds what they saw. No React here, so the choice is tested on
 * its own.
 */

/** How long a task must have been idle to be offered, in days. */
export const IDLE_DAYS_CHOICES = [1, 3, 7, 14, 30] as const;
export type IdleDays = (typeof IDLE_DAYS_CHOICES)[number];
export const DEFAULT_IDLE_DAYS: IdleDays = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The tasks idle for at least `days`, the longest idle first. */
export function cleanupCandidates(worktrees: readonly TaskWorktree[], days: number, now: Date): TaskWorktree[] {
  const before = now.getTime() - days * DAY_MS;
  return worktrees
    .filter((w) => Date.parse(w.lastActivityAt) <= before)
    .sort((a, b) => Date.parse(a.lastActivityAt) - Date.parse(b.lastActivityAt));
}

/** What ending the task with its branch kept would delete, in words; `null` when nothing. */
export function lossLabel(worktree: TaskWorktree): string | null {
  const { loss } = worktree;
  if (loss.kind === "none") return null;
  if (loss.kind === "unknown") return `what would be lost could not be read (${loss.reason})`;
  return [
    loss.uncommitted > 0 && countLabel(loss.uncommitted, { one: "uncommitted change", other: "uncommitted changes" }),
    loss.strayCommits > 0 && countLabel(loss.strayCommits, { one: "commit outside the branch", other: "commits outside the branch" }),
  ]
    .filter((part) => part !== false)
    .join(", ");
}

/** A task whose loss could not be read is left to its own "End task", where the user can look at it first. */
export function removable(worktree: TaskWorktree): boolean {
  return worktree.loss.kind !== "unknown";
}

/** Selected at the start: the tasks whose end loses nothing. */
export function initiallySelected(candidates: readonly TaskWorktree[]): Set<string> {
  return new Set(candidates.filter((w) => w.loss.kind === "none").map((w) => w.task));
}

/** The selected tasks whose end would lose work: the cleanup asks once more before it removes them. */
export function lossyTasks(candidates: readonly TaskWorktree[], selected: ReadonlySet<string>): TaskWorktree[] {
  return candidates.filter((w) => selected.has(w.task) && w.loss.kind === "work");
}

/**
 * What the cleanup asks the daemon to end a selected task: with its branch kept, and for a task that would lose work
 * the fingerprint of the worktree the user confirmed, so work that came after it is refused.
 */
export function removeRequest(worktree: TaskWorktree): {
  task: string;
  keepBranch: true;
  discardChanges: boolean;
  discardFingerprint?: string;
} {
  const { loss } = worktree;
  if (loss.kind === "work") return { task: worktree.task, keepBranch: true, discardChanges: true, discardFingerprint: loss.fingerprint };
  return { task: worktree.task, keepBranch: true, discardChanges: false };
}
