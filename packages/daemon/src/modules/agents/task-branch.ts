/**
 * The name of a task's branch and worktree directory (ADR-31) from the prompt: the first few words without diacritics,
 * in lower case, with hyphens, and the start of the task identifier, so that two tasks with the same prompt do not
 * collide. Only `[a-z0-9-]`, so the name is a valid git branch and a directory on Windows and macOS without quoting.
 */

import { join } from "node:path";
import { z } from "zod";

/** Without regular expression special characters, because it goes into `TaskBranch` literally. */
export const TASK_BRANCH_PREFIX = "trackwall/";

/**
 * A task branch; only such a branch goes into `tasks.json`, because the daemon deletes it with `branch -D` and turns it
 * into a worktree directory, and the file can be edited by hand. The characters are the ones `taskSlug` gives.
 */
export const TaskBranch = z
  .string()
  .regex(new RegExp(`^${TASK_BRANCH_PREFIX}[a-z0-9][a-z0-9-]*$`), `task branch: ${TASK_BRANCH_PREFIX} and [a-z0-9-]`);
/** Short: the worktree directory lies in the state directory, and Windows has a 260-character limit on a file's whole path in a repo. */
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
 * A task's worktree: `<worktrees directory>/<repo>/<branch without prefix>`. Computed, not stored, so `tasks.json` cannot
 * point to a directory outside the worktrees directory (the repo identifier and the branch have no path separators).
 */
export function taskWorktree(worktreesDir: string, repo: string, branch: string): string {
  return join(worktreesDir, repo, branch.slice(TASK_BRANCH_PREFIX.length));
}
