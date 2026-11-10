/**
 * The name of a task's branch and worktree directory (ADR-31) from the prompt: the first few words without diacritics,
 * in lower case, with hyphens, and the start of the task identifier, so that two tasks with the same prompt do not
 * collide. Only `[a-z0-9-]`, so the name is a valid git branch and a directory on Windows and macOS without quoting.
 * The branch puts the workspace's task branch prefix in front of it (ADR-239), `trackwall/` by default.
 */

import { join } from "node:path";
import { TASK_BRANCH_PREFIX_PATTERN } from "@trackwall/protocol";
import { z } from "zod";

/**
 * A task branch; only such a branch goes into `tasks.json`, because the daemon deletes it with `branch -D` and turns it
 * into a worktree directory, and the file can be edited by hand. A task branch prefix (any, since the user may have
 * changed it since the task started; ADR-239) and the characters `taskSlug` gives, so never a branch without a folder,
 * such as `main`.
 */
export const TaskBranch = z
  .string()
  .regex(new RegExp(`^${TASK_BRANCH_PREFIX_PATTERN}[a-z0-9][a-z0-9-]*$`), "task branch: a prefix such as trackwall/ and [a-z0-9-]");

/** Whether `branch` is a task branch with one of `prefixes`: a branch of a task Trackwall no longer knows. */
export function isTaskBranchUnder(branch: string, prefixes: readonly string[]): boolean {
  return TaskBranch.safeParse(branch).success && prefixes.includes(branch.slice(0, slugStart(branch)));
}

/** The part of a task branch after its prefix, which ends with the name's last `/`. */
function taskSlugOf(branch: string): string {
  return branch.slice(slugStart(branch));
}

function slugStart(branch: string): number {
  return branch.lastIndexOf("/") + 1;
}

/** Short: the worktree lies in the task worktrees folder, deeper than the repo root, and Windows has a 260-character limit on a file's whole path in a repo. */
const SLUG_MAX = 32;
const ID_CHARS = 6;

/** Letters NFD does not split into a base letter and a diacritic. */
const UNDECOMPOSED: Record<string, string> = { ł: "l", ø: "o", ß: "ss", æ: "ae", œ: "oe", đ: "d" };

/** The last segment of a task branch and also the name of its worktree directory, e.g. `fix-login-3f2a9c`. */
export function taskSlug(prompt: string, taskId: string): string {
  const words = prompt
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[łøßæœđ]/g, (c) => UNDECOMPOSED[c] ?? c)
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== "");
  let slug = "";
  for (const word of words) {
    const next = slug === "" ? word : `${slug}-${word}`;
    if (next.length > SLUG_MAX) break;
    slug = next;
  }
  // A first word longer than the limit is cut instead of disappearing.
  if (slug === "" && words[0]) slug = words[0].slice(0, SLUG_MAX);
  const suffix = taskId.replaceAll("-", "").slice(0, ID_CHARS);
  return slug === "" ? `task-${suffix}` : `${slug}-${suffix}`;
}

/**
 * A task's worktree: `<task worktrees folder>/<repo>/<branch without prefix>` (ADR-84). Computed, not stored, so `tasks.json`
 * cannot point to a directory outside the task's folder (the repo identifier and the part of the branch after its last
 * `/` have no path separators).
 */
export function taskWorktree(worktreesDir: string, repo: string, branch: string): string {
  return join(worktreesDir, repo, taskSlugOf(branch));
}
