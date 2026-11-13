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
 * Only the user's global and system config does, as in their terminal. A task's refresh from its base branch (ADR-244)
 * makes its merge the same way, with the merged objects written into the repo (`mergeIntoRepo`).
 */

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const OBJECT_FORMATS = new Set(["sha1", "sha256"]);

/** The two sides' commits and where their repo keeps its objects, read in the repo. */
export interface TrialMergeInput {
  objects: string;
  objectFormat: string;
  ours: string;
  theirs: string;
}

/**
 * The commits `ours` and `theirs` name in `repoDir` (`refs/heads/<branch>`, or a commit), with the repo's objects folder;
 * `null` when git cannot read them (a branch that is gone, a repo git cannot read).
 */
export async function trialMergeInput(repoDir: string, ours: string, theirs: string): Promise<TrialMergeInput | null> {
  const read = await git(repoDir, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
    "--show-object-format",
    `${ours}^{commit}`,
    `${theirs}^{commit}`,
  ]).catch(() => null);
  if (read === null) return null;
  const [commonDir, objectFormat, ourCommit, theirCommit] = read.stdout.toString("utf8").trim().split(/\r?\n/);
  if (!commonDir || !objectFormat || !OBJECT_FORMATS.has(objectFormat)) return null;
  if (!ourCommit || !OBJECT_ID.test(ourCommit) || !theirCommit || !OBJECT_ID.test(theirCommit)) return null;
  return { objects: join(commonDir, "objects"), objectFormat, ours: ourCommit, theirs: theirCommit };
}

/**
 * The paths that conflict when the two commits are merged, from their merge base; empty when they merge cleanly. `null`
 * when git cannot tell (older than 2.38, a timeout). The scratch git directory lies in `scratchDir` and is removed afterwards.
 */
export async function trialMergeConflicts(input: TrialMergeInput, scratchDir: string): Promise<string[] | null> {
  try {
    return (await mergeTree(input, scratchDir, null)).conflicts;
  } catch {
    // Only a warning rests on it: a merge git could not try is no conflict to report, nor a failure of the warning.
    return null;
  }
}

/**
 * The merge of the two commits as a tree in the repo's own objects (ADR-244), with the paths that conflict: a tree that
 * holds conflict markers when there are any, which the caller then does not commit. A git that cannot merge in memory
 * (older than 2.38) or a timeout is an exception.
 */
export function mergeIntoRepo(input: TrialMergeInput, scratchDir: string): Promise<{ tree: string; conflicts: string[] }> {
  return mergeTree(input, scratchDir, input.objects);
}

/** `git merge-tree` in a scratch git directory that reads the repo's objects and writes new ones into `objectDirectory`, or its own. */
async function mergeTree(
  input: TrialMergeInput,
  scratchDir: string,
  objectDirectory: string | null,
): Promise<{ tree: string; conflicts: string[] }> {
  const scratch = await mkdtemp(join(scratchDir, "trial-merge-"));
  try {
    await borrowingGitDir(scratch, input.objects, input.objectFormat);
    const merged = await git(
      scratch,
      // Bare and named explicitly, which `safe.bareRepository=explicit` allows.
      [`--git-dir=${scratch}`, "merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", input.ours, input.theirs],
      // 1 is "the merge has conflicts", a result.
      { okExitCodes: [1], ...(objectDirectory !== null && { objectDirectory }) },
    );
    return mergeTreeResult(merged.stdout.toString("utf8"));
  } finally {
    // A leftover folder in the scratch folder harms nothing, so failing to remove it does not fail the merge.
    await removeFolder(scratch, removeIfPresent).catch(() => undefined);
  }
}

/**
 * `--name-only -z` output: the merged tree, then each conflicted path (a path with several conflicts more than once),
 * then an empty entry before the messages, which `--no-messages` leaves out.
 */
export function mergeTreeResult(output: string): { tree: string; conflicts: string[] } {
  const [tree, ...rest] = output.split("\0");
  if (tree === undefined || !OBJECT_ID.test(tree)) throw new Error(`unexpected git merge-tree output: ${output.slice(0, 200)}`);
  const end = rest.indexOf("");
  return { tree, conflicts: [...new Set(end === -1 ? rest : rest.slice(0, end))] };
}
