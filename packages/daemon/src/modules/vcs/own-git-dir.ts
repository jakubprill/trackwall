import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isInside } from "../../infra/path-inside.ts";
import type { RunOutput } from "../../infra/run-program.ts";
import { type GitOptions, git } from "./git.ts";
import { pathKey } from "./path-key.ts";

/**
 * A task worktree's own git directory (ADR-168): a worktree's `.git` is a file the agent can rewrite to point at a git
 * directory of its own, whose config would name programs (filters) for `git add` or `reset` to run, so every write the
 * daemon makes in a task worktree (a round commit, an undo, a refresh from the base branch) first checks that the git
 * directory is this worktree's own in its repo, and then names it (`--git-dir`), so a `.git` rewritten after the check is
 * never read.
 */

/** A task worktree: its directory and the repo root it was made from. */
export interface WorktreePlace {
  worktree: string;
  repoDir: string;
}

/** Runs git in the worktree with the git directory checked by `ownGitDir`. */
export type OwnGit = (args: readonly string[], opts?: GitOptions) => Promise<RunOutput>;

/**
 * Git in the worktree pinned to its checked git directory, or why its git directory is not this worktree's own in its
 * repo: the common directory must be the repo's, and the git directory one of its `worktrees/` whose `gitdir` file
 * names this worktree, so neither a git directory of the agent's nor another task's worktree passes.
 */
export async function ownGitDir(place: WorktreePlace): Promise<OwnGit | { foreign: string }> {
  const gitDir = await checkedGitDir(place);
  if (gitDir.foreign !== undefined) return { foreign: gitDir.foreign };
  const pin = [`--git-dir=${gitDir.path}`, `--work-tree=${place.worktree}`];
  return (args, opts) => git(place.worktree, [...pin, ...args], opts);
}

const FOREIGN_GIT_DIR = "the worktree's .git does not point to a worktree of its repo, so Trackwall does not run git there";

async function checkedGitDir({ worktree, repoDir }: WorktreePlace): Promise<{ path: string; foreign?: undefined } | { foreign: string }> {
  const absolute = ["rev-parse", "--path-format=absolute"];
  const [own, repo] = await Promise.all([
    git(worktree, [...absolute, "--git-dir", "--git-common-dir"]),
    git(repoDir, [...absolute, "--git-common-dir"]),
  ]);
  const [gitDir, commonDir] = own.stdout.toString("utf8").trim().split(/\r?\n/);
  const repoCommon = repo.stdout.toString("utf8").trim();
  if (gitDir === undefined || commonDir === undefined) return { foreign: "git did not name the worktree's git directory" };
  const [gitKey, commonKey, repoKey] = await Promise.all([pathKey(gitDir), pathKey(commonDir), pathKey(repoCommon)]);
  if (commonKey !== repoKey || !isInside(join(repoKey, "worktrees"), gitKey) || gitKey === join(repoKey, "worktrees"))
    return { foreign: FOREIGN_GIT_DIR };
  const backLink = await readFile(join(gitDir, "gitdir"), "utf8").catch(() => "");
  const [linkKey, ownKey] = await Promise.all([pathKey(resolve(gitDir, backLink.trim())), pathKey(join(worktree, ".git"))]);
  if (backLink.trim() === "" || linkKey !== ownKey) return { foreign: FOREIGN_GIT_DIR };
  return { path: gitDir };
}

export async function assertOwnGitDir(place: WorktreePlace): Promise<OwnGit> {
  const own = await ownGitDir(place);
  if (typeof own !== "function") throw new Error(own.foreign);
  return own;
}
