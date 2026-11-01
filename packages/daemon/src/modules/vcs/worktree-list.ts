import { git } from "./git.ts";

/**
 * The one reader of `git worktree list --porcelain` (§4.5). Lines instead of `-z`, which git has only since 2.36; a path
 * with a newline in it is not supported, as git itself quotes nothing there.
 */

export interface ListedWorktree {
  path: string;
  /** The checked-out commit; `null` in a repo without commits and for a bare repo. */
  head: string | null;
  /** The checked-out branch as a full ref (`refs/heads/main`); `null` on a detached HEAD. */
  branch: string | null;
  /** Bare, or prunable (its directory is gone): there is no working tree to read. */
  readable: boolean;
}

export function parseWorktreeList(out: string): ListedWorktree[] {
  const worktrees: ListedWorktree[] = [];
  let current: ListedWorktree | undefined;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), head: null, branch: null, readable: true };
      worktrees.push(current);
    } else if (current) {
      readField(current, line);
    }
  }
  return worktrees;
}

function readField(worktree: ListedWorktree, line: string): void {
  if (line.startsWith("HEAD ")) {
    const oid = line.slice("HEAD ".length);
    worktree.head = /^0+$/.test(oid) ? null : oid;
  } else if (line.startsWith("branch ")) {
    worktree.branch = line.slice("branch ".length);
  } else if (line === "bare" || line.startsWith("prunable")) {
    worktree.readable = false;
  }
}

/** The repo's worktrees, its own one first. */
export async function listWorktrees(dir: string): Promise<ListedWorktree[]> {
  return parseWorktreeList((await git(dir, ["worktree", "list", "--porcelain"])).stdout.toString("utf8"));
}
