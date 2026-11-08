import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { removeFolder, removeIfPresent } from "../../infra/remove-folder.ts";
import { borrowingGitDir } from "./borrowed-objects.ts";
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

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const OBJECT_FORMATS = new Set(["sha1", "sha256"]);

/** The two branches' commits and where their repo keeps its objects, read in the repo. */
export interface TrialMergeInput {
  objects: string;
  objectFormat: string;
  ours: string;
  theirs: string;
}

/**
 * The commits of the branches `ours` and `theirs` of `repoDir`, with the repo's objects folder; `null` when git cannot
 * read them (a branch that is gone, a repo git cannot read).
 */
export async function trialMergeInput(repoDir: string, ours: string, theirs: string): Promise<TrialMergeInput | null> {
  const read = await git(repoDir, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
    "--show-object-format",
    `refs/heads/${ours}^{commit}`,
    `refs/heads/${theirs}^{commit}`,
  ]).catch(() => null);
  if (read === null) return null;
  const [commonDir, objectFormat, ourCommit, theirCommit] = read.stdout.toString("utf8").trim().split(/\r?\n/);
  if (!commonDir || !objectFormat || !OBJECT_FORMATS.has(objectFormat)) return null;
  if (!ourCommit || !COMMIT.test(ourCommit) || !theirCommit || !COMMIT.test(theirCommit)) return null;
  return { objects: join(commonDir, "objects"), objectFormat, ours: ourCommit, theirs: theirCommit };
}

/**
 * The paths that conflict when the two commits are merged, from their merge base; empty when they merge cleanly. `null`
 * when git cannot tell (older than 2.38, a timeout). The scratch git directory lies in `scratchDir` and is removed afterwards.
 */
export async function trialMergeConflicts(input: TrialMergeInput, scratchDir: string): Promise<string[] | null> {
  const scratch = await mkdtemp(join(scratchDir, "trial-merge-"));
  try {
    await borrowingGitDir(scratch, input.objects, input.objectFormat);
    const merged = await git(
      scratch,
      // Bare and named explicitly, which `safe.bareRepository=explicit` allows.
      [`--git-dir=${scratch}`, "merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", input.ours, input.theirs],
      // 1 is "the merge has conflicts", a result.
      { okExitCodes: [1] },
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
