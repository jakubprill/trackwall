import type { UnpushedRepo } from "@trackwall/protocol";
import { git } from "./git.ts";
import { gitDirs } from "./git-dir.ts";
import { pathKey } from "./path-key.ts";
import { listWorktrees } from "./worktree-list.ts";

/**
 * What of a repo lives only in its own git directory and working trees, not on any remote (ADR-162): commits that no
 * remote-tracking branch reaches (on local branches and on the detached HEAD of a worktree), stashes, and changed files in
 * every worktree. In a container this work is only in the Docker volume, and removing the volume takes it with it. Read
 * from refs git already has: nothing is fetched, so a branch pushed from elsewhere counts until the next sync.
 */

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
export type RepoUnpushed = Omit<UnpushedRepo, "repo"> & {
  /** The repo's git directory shared by its worktrees, as a path key: two list entries of one repo count once. */
  commonDir: string;
};

/** Changed and untracked files in a worktree (`Vcs.status`, so a list refreshed often reuses it, ADR-141). */
export type WorktreeChanges = (dir: string) => Promise<number>;

export async function readUnpushed(dir: string, changesIn: WorktreeChanges): Promise<RepoUnpushed> {
  const dirs = await gitDirs(dir);
  if (dirs === null) throw new Error(`${dir} has no git directory`);
  const [main, ...others] = await listWorktrees(dir);
  const heads = [main, ...others].flatMap((w) => (w?.head ? [w.head] : []));
  const [commonDir, remotes, log, stashes, changes] = await Promise.all([
    pathKey(dirs.commonDir),
    gitText(dir, ["remote"]),
    gitText(dir, ["log", "-z", "--format=%D", "--decorate-refs=refs/heads/", "--branches", ...heads, "--not", "--remotes", "--"]),
    gitText(dir, ["stash", "list", "--format=%H"]),
    // The repo's own worktree by the path it was asked for, which git lists resolved: so its status is the repo list's.
    Promise.all([changesIn(dir), ...others.filter((w) => w.readable).map((w) => changesIn(w.path))]),
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
