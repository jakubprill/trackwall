import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { removeFolder, removeIfPresent } from "../../infra/remove-folder.ts";
import { git } from "./git.ts";

/**
 * A trial merge of two branches of one repo (ADR-230): the files in which merging one into the other would conflict, as
 * the shared-files warning of two tasks names them (ADR-44). `git merge-tree --write-tree` (git 2.38+) merges in memory,
 * without a worktree or an index, but writes the merged objects, so it runs in a scratch git directory of the daemon's
 * own that reads the repo's objects through `objects/info/alternates`: the repo gets no objects every few seconds,
 * several windows asking at once never write the same object (on Windows "Permission denied", #36), and nothing an
 * agent can write in the repo (its `.git/config` with a merge driver's program, `info/attributes`, hooks) plays a part.
 * Only the user's global and system config does, as in their terminal.
 */

/** `merge-tree` on a large repo with many renames can take seconds on Windows with a scanning antivirus. */
const TRIAL_MERGE_TIMEOUT_MS = 15_000;

/**
 * The paths that conflict when `ours` and `theirs` (branch names in `repoDir`) are merged, from their merge base;
 * empty when they merge cleanly. `null` when git cannot tell: a git older than 2.38, a branch that is gone, a
 * repo git cannot read. The scratch git directory lies in `scratchDir` and is removed afterwards.
 */
export async function trialMergeConflicts(repoDir: string, ours: string, theirs: string, scratchDir: string): Promise<string[] | null> {
  const scratch = await mkdtemp(join(scratchDir, "trial-merge-"));
  try {
    const read = await git(repoDir, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
      "--show-object-format",
      `refs/heads/${ours}^{commit}`,
      `refs/heads/${theirs}^{commit}`,
    ]);
    const [commonDir, objectFormat, ourCommit, theirCommit] = read.stdout.toString("utf8").trim().split(/\r?\n/);
    if (!commonDir || !objectFormat || !ourCommit || !theirCommit) return null;
    await borrowingGitDir(scratch, join(commonDir, "objects"), objectFormat);
    const merged = await git(
      scratch,
      [`--git-dir=${scratch}`, "merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", ourCommit, theirCommit],
      // 1 is "the merge has conflicts", a result.
      { okExitCodes: [1], timeoutMs: TRIAL_MERGE_TIMEOUT_MS },
    );
    return conflictedPaths(merged.stdout.toString("utf8"));
  } catch {
    // Only a warning rests on it: a merge git could not try is no conflict to report, nor a failure of the warning.
    return null;
  } finally {
    // A leftover folder in the scratch folder harms nothing, so failing to remove it does not fail the read.
    await removeFolder(scratch, removeIfPresent).catch(() => undefined);
  }
}

/**
 * `--name-only -z` output: the merged tree, then each conflicted path (a path with several conflicts more than once),
 * then an empty entry before the messages, which `--no-messages` leaves out.
 */
export function conflictedPaths(output: string): string[] {
  const [, ...rest] = output.split("\0");
  const end = rest.indexOf("");
  return [...new Set(end === -1 ? rest : rest.slice(0, end))];
}

/** An empty git directory in `dir` that reads its objects from `objects` and writes new ones into its own. */
async function borrowingGitDir(dir: string, objects: string, objectFormat: string): Promise<void> {
  await mkdir(join(dir, "objects", "info"), { recursive: true });
  await mkdir(join(dir, "refs"));
  await writeFile(join(dir, "HEAD"), "ref: refs/heads/main\n");
  const format = objectFormat === "sha1" ? "" : `[extensions]\n\tobjectformat = ${objectFormat}\n`;
  await writeFile(join(dir, "config"), `[core]\n\trepositoryformatversion = ${format ? 1 : 0}\n\tbare = true\n${format}`);
  // Forward slashes, which git reads on every system.
  await writeFile(join(dir, "objects", "info", "alternates"), `${objects.replaceAll("\\", "/")}\n`);
}
