import { resolve } from "node:path";
import { git } from "./git.ts";
import { pathKey } from "./path-key.ts";

/**
 * What of a repo lives only in its own git directory and working trees, not on any remote (ADR-162): commits that no
 * remote-tracking branch reaches (on local branches and on the detached HEAD of a worktree), stashes, and changed files in
 * every worktree. In a container this work is only in the Docker volume, and removing the volume takes it with it. Read
 * from refs git already has: nothing is fetched, so a branch pushed from elsewhere counts until the next sync.
 */

/** A worktree as `git worktree list --porcelain -z` lists it. */
export interface ListedWorktree {
  path: string;
  /** The checked-out commit; `null` in a repo without commits and for a bare repo. */
  head: string | null;
  /** Bare, or prunable (its directory is gone): there is no working tree to read. */
  readable: boolean;
}

export function parseWorktreeList(out: string): ListedWorktree[] {
  const worktrees: ListedWorktree[] = [];
  let current: ListedWorktree | undefined;
  for (const field of out.split("\0")) {
    if (field.startsWith("worktree ")) {
      current = { path: field.slice("worktree ".length), head: null, readable: true };
      worktrees.push(current);
    } else if (current && field.startsWith("HEAD ")) {
      const oid = field.slice("HEAD ".length);
      current.head = /^0+$/.test(oid) ? null : oid;
    } else if (current && (field === "bare" || field.startsWith("prunable"))) {
      current.readable = false;
    }
  }
  return worktrees;
}

/**
 * The output of `git log --format=%D -z --decorate-refs=refs/heads/` over the commits on no remote: one NUL-terminated
 * record per commit, holding the names of the local branches that point at it. Each branch with commits on no remote points
 * at one of them, since a tip a remote reaches has every commit before it reached too.
 */
export function parseUnpushedLog(out: string): { commits: number; branches: string[] } {
  const records = out.split("\0");
  // The last record is the empty text after the final NUL.
  records.pop();
  const branches = records.flatMap((record) => record.split(", ").filter((name) => name !== ""));
  return { commits: records.length, branches: [...new Set(branches)].sort() };
}

/** The unpushed work of one repo and every worktree it has, task worktrees included. */
export interface RepoUnpushed {
  /** The repo's git directory shared by its worktrees, as a path key: two list entries of one repo count once. */
  commonDir: string;
  commits: number;
  branches: string[];
  /** The repo has no remote at all, so every commit counts. */
  noRemote: boolean;
  stashes: number;
  /** Changed and untracked files across the worktrees. */
  changes: number;
  /** The worktrees with changed or untracked files, the repo's own one included. */
  changedWorktrees: number;
}

/** Changed and untracked files in a worktree (`Vcs.status`, so a list refreshed often reuses it, ADR-141). */
export type WorktreeChanges = (dir: string) => Promise<number>;

export async function readUnpushed(dir: string, changesIn: WorktreeChanges): Promise<RepoUnpushed> {
  const worktrees = parseWorktreeList(await gitText(dir, ["worktree", "list", "--porcelain", "-z"]));
  const heads = worktrees.flatMap((w) => (w.head === null ? [] : [w.head]));
  const [commonDir, remotes, log, stashes, changes] = await Promise.all([
    gitText(dir, ["rev-parse", "--git-common-dir"]).then((out) => pathKey(resolve(dir, out.trim()))),
    gitText(dir, ["remote"]),
    gitText(dir, ["log", "-z", "--format=%D", "--decorate-refs=refs/heads/", "--branches", ...heads, "--not", "--remotes", "--"]),
    gitText(dir, ["stash", "list", "--format=%H"]),
    Promise.all(worktrees.filter((w) => w.readable).map((w) => changesIn(w.path))),
  ]);
  const { commits, branches } = parseUnpushedLog(log);
  return {
    commonDir,
    commits,
    branches,
    noRemote: remotes.trim() === "",
    stashes: stashes.split("\n").filter((line) => line.trim() !== "").length,
    changes: changes.reduce((sum, n) => sum + n, 0),
    changedWorktrees: changes.filter((n) => n > 0).length,
  };
}

async function gitText(dir: string, args: readonly string[]): Promise<string> {
  return (await git(dir, args)).stdout.toString("utf8");
}
