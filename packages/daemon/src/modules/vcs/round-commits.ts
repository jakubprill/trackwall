import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { WorkingTreeChanges } from "@trackwall/protocol";
import { isAncestor } from "./commit-range.ts";
import { existingCommit, git, symbolicRef } from "./git.ts";
import { mainRemote, readConfig } from "./git-config.ts";
import { withoutHooks } from "./no-hooks.ts";
import { parseChangedFiles, parseStatus } from "./parse.ts";
import { wholeLines } from "./worktree-changes.ts";

/**
 * The git side of task rounds (§4.4, ADR-168), in a task worktree only: what the worktree is at, a round commit of what
 * the agent left uncommitted, a round's diff, the reset that undoes a round, and the squash of the round commits before
 * the push. None of it runs the repo's hooks, which the agent can change in the worktree (`no-hooks.ts`), or signs a
 * commit, which could wait for a PIN the daemon cannot type. Round commits carry the user's own git identity, like a
 * commit from their terminal, because the work in them is the task's. The squash rewrites only commits the remote does
 * not have yet, keeps every author, committer and message of the agent's own commits, and moves the branch only from the
 * commit it read (`update-ref` with the old value), so a commit made meanwhile is never lost.
 */

/** `git add -A` and a commit of a large worktree on Windows with a scanning antivirus can take a dozen seconds. */
const ROUND_TIMEOUT_MS = 60_000;

/** No hooks, no signing and no `gc --auto` at the end of a turn, which would hold the worktree for minutes. */
const ROUND_CONFIG = ["commit.gpgSign=false", "gc.auto=0"];

/** Files git keeps in the git directory while an operation waits for the user, with the operation's name. */
const OPERATIONS = [
  ["MERGE_HEAD", "a merge"],
  ["CHERRY_PICK_HEAD", "a cherry-pick"],
  ["REVERT_HEAD", "a revert"],
  ["rebase-merge", "a rebase"],
  ["rebase-apply", "a rebase or git am"],
  ["BISECT_LOG", "a bisect"],
] as const;

/** Where a task worktree is for a round: HEAD, whether it is on the task branch, its `git status` entries and an operation in progress. */
export interface RoundWorktree {
  head: string | null;
  onBranch: boolean;
  uncommitted: number;
  /** An operation git waits in (`a merge`); `null` for none. */
  operation: string | null;
}

export async function roundWorktree(dir: string, branch: string): Promise<RoundWorktree> {
  const [head, ref, status, operation] = await Promise.all([
    existingCommit(dir, "HEAD"),
    symbolicRef(dir, "HEAD"),
    git(dir, ["status", "--porcelain=v2", "-z", "--untracked-files=all"], { timeoutMs: ROUND_TIMEOUT_MS }),
    operationInProgress(dir),
  ]);
  return {
    head: head ?? null,
    onBranch: ref === `refs/heads/${branch}`,
    uncommitted: parseStatus(status.stdout.toString("utf8")).changes,
    operation,
  };
}

async function operationInProgress(dir: string): Promise<string | null> {
  const args = OPERATIONS.flatMap(([file]) => ["--git-path", file]);
  const paths = (await git(dir, ["rev-parse", ...args])).stdout.toString("utf8").split(/\r?\n/);
  const found = OPERATIONS.find((_, i) => {
    const path = paths[i]?.trim();
    return path !== undefined && path !== "" && existsSync(resolve(dir, path));
  });
  return found?.[1] ?? null;
}

/**
 * Commits every change of the worktree (`git add -A`: new, changed and deleted files, without ignored ones) on the
 * checked-out branch, and returns the new HEAD. The caller checked the worktree is on the task branch with no operation
 * in progress; git refuses a commit without an identity, and that error goes to the caller.
 */
export async function commitRound(dir: string, message: string): Promise<string> {
  return withoutHooks(async (hooksPath) => {
    const config = [hooksPath, ...ROUND_CONFIG];
    await git(dir, ["add", "--all", "--", "."], { timeoutMs: ROUND_TIMEOUT_MS, config });
    await git(dir, ["commit", "--quiet", "--no-verify", "-m", message], { timeoutMs: ROUND_TIMEOUT_MS, config });
    const head = await existingCommit(dir, "HEAD");
    if (head === undefined) throw new Error("git committed, but HEAD has no commit");
    return head;
  });
}

/** Files and diff from commit `from` to commit `to`, the diff cut within `maxPatchBytes`, as a task's changes are read (ADR-31). */
export async function roundChanges(dir: string, from: string, to: string, maxPatchBytes: number): Promise<WorkingTreeChanges> {
  const diff = (args: string[], maxBytes?: number) =>
    git(dir, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", ...args, from, to, "--"], {
      timeoutMs: ROUND_TIMEOUT_MS,
      maxBytes,
    });
  const [names, stats, patch] = await Promise.all([
    diff(["--name-status", "-z"]),
    diff(["--numstat", "-z"]),
    diff(["--src-prefix=a/", "--dst-prefix=b/"], maxPatchBytes),
  ]);
  return {
    files: parseChangedFiles(names.stdout.toString("utf8"), stats.stdout.toString("utf8")).slice(0, names.truncated ? -1 : undefined),
    patch: wholeLines(patch).toString("utf8"),
    truncated: patch.truncated || names.truncated || stats.truncated,
  };
}

/**
 * Undoes a round: the checked-out branch and the working directory go back to commit `to`, which must be in HEAD's
 * history, so a hand-edited state file cannot reset the branch to any commit. Ignored files (builds) stay; the caller
 * checked that the worktree has no `git status` entries, so nothing else is lost.
 */
export async function resetRound(dir: string, to: string): Promise<void> {
  if (!(await isAncestor(dir, to, "HEAD"))) throw new Error(`commit ${to} is not in the history of HEAD`);
  await withoutHooks((hooksPath) =>
    git(dir, ["reset", "--hard", "--quiet", to, "--"], { timeoutMs: ROUND_TIMEOUT_MS, config: [hooksPath] }),
  );
}

/**
 * Squashes the round commits (`roundCommits`) of task branch `branch` that the main remote does not have yet, and returns
 * the new HEAD, or `null` when there was none to squash. Each run of round commits joins the agent's commit after it,
 * which keeps its author, committer and message and already holds their content; round commits at the end become one
 * commit with `message`. Only a straight history is rewritten: a merge commit in the range is refused, and the caller
 * pushes nothing then. The working directory and index stay as they are, since the new HEAD has the same tree.
 */
export async function squashRounds(
  dir: string,
  branch: string,
  base: string,
  roundCommits: ReadonlySet<string>,
  message: string,
): Promise<string | null> {
  const ref = `refs/heads/${branch}`;
  const head = await existingCommit(dir, ref);
  if (head === undefined) throw new Error(`branch ${branch} has no commit`);
  const pushed = await pushedTip(dir, branch);
  const range = await linearCommits(dir, head, [base, ...(pushed === null ? [] : [pushed])]);
  if (!range.commits.some((c) => roundCommits.has(c))) return null;
  return withoutHooks(async (hooksPath) => {
    const config = [hooksPath];
    let parent = range.start;
    let lastRound: Buffer | null = null;
    for (const commit of range.commits) {
      const raw = (await git(dir, ["cat-file", "commit", commit], { config })).stdout;
      if (roundCommits.has(commit)) {
        lastRound = raw;
        continue;
      }
      parent = await writeCommit(dir, withParent(raw, parent, null), config);
      lastRound = null;
    }
    // A round commit's tree is HEAD's when it is the last commit; it keeps that commit's identity and dates.
    if (lastRound !== null) parent = await writeCommit(dir, withParent(lastRound, parent, Buffer.from(`${message}\n`, "utf8")), config);
    await git(dir, ["update-ref", "-m", "trackwall: squash round commits", ref, parent, head], { config });
    return parent;
  });
}

/** The main remote's branch of the same name as the last fetch or push left it; `null` without one. */
export async function pushedTip(dir: string, branch: string): Promise<string | null> {
  const remote = mainRemote(await readConfig(dir));
  if (!remote) return null;
  return (await existingCommit(dir, `refs/remotes/${remote.name}/${branch}`)) ?? null;
}

/** The commits of `head` none of `exclude` has, oldest first, and the commit the first of them builds on; refused for a merge. */
async function linearCommits(dir: string, head: string, exclude: readonly string[]): Promise<{ start: string; commits: string[] }> {
  const { stdout } = await git(dir, ["rev-list", "--reverse", "--parents", head, ...exclude.map((c) => `^${c}`), "--"]);
  const rows = stdout
    .toString("utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.split(" "));
  const commits: string[] = [];
  let start: string | undefined;
  for (const [commit, ...parents] of rows) {
    if (commit === undefined || parents.length !== 1 || parents[0] === undefined)
      throw new Error(`commit ${commit ?? "?"} is a merge or has no parent; Trackwall squashes round commits only on a straight history`);
    if (commits.length === 0) start = parents[0];
    else if (parents[0] !== commits.at(-1))
      throw new Error("the branch's new commits branch off; Trackwall squashes round commits only on a straight history");
    commits.push(commit);
  }
  return { start: start ?? head, commits };
}

/**
 * A commit object like `raw`, on `parent`, with `message` instead of its own when given: the header keeps the tree,
 * author, committer and encoding, and loses the parents and any signature, which would no longer match.
 */
function withParent(raw: Buffer, parent: string, message: Buffer | null): Buffer {
  const split = raw.indexOf("\n\n");
  const header = (split === -1 ? raw : raw.subarray(0, split)).toString("latin1").split("\n");
  const body = split === -1 ? Buffer.alloc(0) : raw.subarray(split + 2);
  const kept: string[] = [];
  let inSignature = false;
  for (const line of header) {
    if (line.startsWith(" ")) {
      if (!inSignature) kept.push(line);
      continue;
    }
    inSignature = line.startsWith("gpgsig ") || line.startsWith("gpgsig-sha256 ") || line.startsWith("mergetag ");
    if (inSignature || line.startsWith("parent ")) continue;
    kept.push(line);
    if (line.startsWith("tree ")) kept.push(`parent ${parent}`);
  }
  return Buffer.concat([Buffer.from(`${kept.join("\n")}\n\n`, "latin1"), message ?? body]);
}

async function writeCommit(dir: string, object: Buffer, config: readonly string[]): Promise<string> {
  const { stdout } = await git(dir, ["hash-object", "-t", "commit", "-w", "--stdin"], { stdin: object, config });
  return stdout.toString("utf8").trim();
}
