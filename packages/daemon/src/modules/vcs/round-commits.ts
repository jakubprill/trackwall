import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { WorkingTreeChanges } from "@trackwall/protocol";
import { isAncestor } from "./commit-range.ts";
import { existingCommit, git, symbolicRef } from "./git.ts";
import { mainRemote, readConfig } from "./git-config.ts";
import { withoutHooks } from "./no-hooks.ts";
import { assertOwnGitDir, type OwnGit, ownGitDir } from "./own-git-dir.ts";
import { parseChangedFiles, parseNulTerminated, parseStatus } from "./parse.ts";
import { wholeLines } from "./worktree-changes.ts";

/**
 * The git side of task rounds (§4.4, ADR-168), in a task worktree only: what the worktree is at, a round commit of what
 * the agent left uncommitted, a round's diff, the reset that undoes a round, and the squash of the round commits before
 * the push. A worktree's `.git` is a file the agent can rewrite to point at a git directory of its own, whose config
 * would name programs (filters) for `git add` or `reset` to run, so every write first checks that the worktree's git
 * directory is this worktree's own in its repo (`ownGitDir`), and the commands that touch the index or the files then
 * name that directory (`--git-dir`), so a `.git` rewritten after the check is never read. None of it runs the repo's hooks, which the agent can change in
 * the worktree (`no-hooks.ts`), or signs a commit, which could wait for a PIN the daemon cannot type. Round commits carry
 * the user's own git identity, like a commit from their terminal, because the work in them is the task's. The squash
 * builds new commits without moving the branch, which the caller moves (`moveBranch`), from the commit the squash read.
 */

/** `git add -A` and a commit of a large worktree on Windows with a scanning antivirus can take a dozen seconds. */
const ROUND_TIMEOUT_MS = 60_000;

/** No signing and no `gc --auto` at the end of a turn, which would hold the worktree for minutes. */
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

/** A task worktree: its directory, the repo root it was made from, and the task branch. */
export interface RoundPlace {
  worktree: string;
  repoDir: string;
  branch: string;
}

/** Where a task worktree is for a round: HEAD, whether it is on the task branch, its `git status` entries and an operation in progress. */
export interface RoundWorktree {
  head: string | null;
  onBranch: boolean;
  uncommitted: number;
  /** Why git must not run there for a round (an operation waits, `.git` points elsewhere); `null` when it may. */
  blocker: string | null;
}

export async function roundWorktree(place: RoundPlace): Promise<RoundWorktree> {
  const own = await ownGitDir(place);
  if (typeof own !== "function") return { head: null, onBranch: false, uncommitted: 0, blocker: own.foreign };
  const dir = place.worktree;
  const [head, ref, status, operation] = await Promise.all([
    existingCommit(dir, "HEAD"),
    symbolicRef(dir, "HEAD"),
    own(["status", "--porcelain=v2", "-z", "--untracked-files=all"], { timeoutMs: ROUND_TIMEOUT_MS }),
    operationInProgress(dir),
  ]);
  return {
    head: head ?? null,
    onBranch: ref === `refs/heads/${place.branch}`,
    uncommitted: parseStatus(status.stdout.toString("utf8")).changes,
    blocker: operation === null ? null : `${operation} is in progress in the worktree`,
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
 * checked-out branch, except the paths in `keepOut` (the files copied into the worktree for the task, ADR-61, which a
 * changed `.gitignore` would otherwise let in), and returns HEAD: the new commit, or the old HEAD when nothing was left
 * to commit. The caller checked the worktree is on the task branch with nothing in progress; git refuses a commit
 * without an identity, and that error goes to the caller.
 */
export async function commitRound(place: RoundPlace, message: string, keepOut: readonly string[]): Promise<string> {
  const own = await assertOwnGitDir(place);
  return withoutHooks(async (hooksPath) => {
    const opts = { timeoutMs: ROUND_TIMEOUT_MS, config: [hooksPath, ...ROUND_CONFIG] };
    const excluded = keepOut.map((path) => `:(top,literal,exclude)${path}`);
    await own(["add", "--all", "--", ".", ...excluded], opts);
    // A kept-out file the agent staged itself (`git add -f`) leaves the index too.
    if (keepOut.length > 0) await own(["reset", "--quiet", "--", ...keepOut.map((path) => `:(top,literal)${path}`)], opts);
    const staged = await own(["diff", "--cached", "--name-only", "-z", "--no-ext-diff"], opts);
    if (parseNulTerminated(staged.stdout).length > 0) await own(["commit", "--quiet", "--no-verify", "-m", message], opts);
    const head = await existingCommit(place.worktree, "HEAD");
    if (head === undefined) throw new Error("the task branch has no commit");
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
 * Undoes a round: while HEAD is still the task branch at `head`, the branch and the working directory go back to commit
 * `to`, which must be in HEAD's history, so a hand-edited state file cannot reset the branch to any commit. `reset
 * --keep` refuses rather than overwrite a file changed since the caller's check; ignored files (builds) stay.
 */
export async function resetRound(place: RoundPlace, head: string, to: string): Promise<void> {
  const own = await assertOwnGitDir(place);
  const dir = place.worktree;
  const [ref, now] = await Promise.all([symbolicRef(dir, "HEAD"), existingCommit(dir, "HEAD")]);
  if (ref !== `refs/heads/${place.branch}` || now !== head) throw new Error("the worktree moved since the round was checked");
  if (!(await isAncestor(dir, to, head))) throw new Error(`commit ${to} is not in the history of HEAD`);
  await withoutHooks((hooksPath) => own(["reset", "--keep", "--quiet", to, "--"], { timeoutMs: ROUND_TIMEOUT_MS, config: [hooksPath] }));
}

/** The squashed history of a task branch, not on the branch yet: `moveBranch` moves the branch from `from` to `to`. */
export interface SquashedRounds {
  from: string;
  to: string;
}

/**
 * The task branch with its round commits (`roundCommits`) squashed, among the commits the main remote does not have yet
 * and that come after the branch's last merge commit (older ones stay as they are); `null` when there is none to squash.
 * Each run of round commits joins the agent's commit after it, which keeps its author, committer and message and already
 * holds their content; round commits at the end become one commit with `message`. Commits before the first round commit
 * stay the same objects, signatures and all. Only objects are written: the branch does not move.
 */
export async function squashRounds(
  place: RoundPlace,
  base: string,
  roundCommits: ReadonlySet<string>,
  message: string,
): Promise<SquashedRounds | null> {
  const own = await assertOwnGitDir(place);
  const dir = place.worktree;
  const head = await existingCommit(dir, `refs/heads/${place.branch}`);
  if (head === undefined) throw new Error(`branch ${place.branch} has no commit`);
  const pushed = await pushedTip(dir, place.branch);
  const range = await straightCommits(dir, head, [base, ...(pushed === null ? [] : [pushed])]);
  if (!range.commits.some((c) => roundCommits.has(c))) return null;
  return withoutHooks(async (hooksPath) => {
    const config = [hooksPath];
    let parent = range.start;
    let rewritten = false;
    let lastRound: Buffer | null = null;
    for (const commit of range.commits) {
      if (roundCommits.has(commit)) {
        lastRound = (await own(["cat-file", "commit", commit], { config })).stdout;
        rewritten = true;
        continue;
      }
      lastRound = null;
      if (!rewritten) {
        parent = commit;
        continue;
      }
      const raw = (await own(["cat-file", "commit", commit], { config })).stdout;
      parent = await writeCommit(own, withParent(raw, parent, null), config);
    }
    // A round commit's tree is HEAD's when it is the last commit; it keeps that commit's identity and dates.
    if (lastRound !== null) parent = await writeCommit(own, withParent(lastRound, parent, Buffer.from(`${message}\n`, "utf8")), config);
    return { from: head, to: parent };
  });
}

/** Moves the task branch from `from` to `to` (the squashed history, or back after a failed push), only while it is at `from`. */
export async function moveBranch(place: RoundPlace, squashed: SquashedRounds): Promise<void> {
  const own = await assertOwnGitDir(place);
  await withoutHooks((hooksPath) =>
    own(["update-ref", "-m", "trackwall: squash round commits", `refs/heads/${place.branch}`, squashed.to, squashed.from], {
      config: [hooksPath],
    }),
  );
}

/** The main remote's branch of the same name as the last fetch or push left it; `null` without one. */
export async function pushedTip(dir: string, branch: string): Promise<string | null> {
  const remote = mainRemote(await readConfig(dir));
  if (!remote) return null;
  return (await existingCommit(dir, `refs/remotes/${remote.name}/${branch}`)) ?? null;
}

/**
 * The commits of `head` none of `exclude` has, oldest first, from the last place the history is not one straight line
 * (a merge commit, or a side line merged into it), and the commit the first of them builds on.
 */
async function straightCommits(dir: string, head: string, exclude: readonly string[]): Promise<{ start: string; commits: string[] }> {
  const { stdout } = await git(dir, ["rev-list", "--topo-order", "--reverse", "--parents", head, ...exclude.map((c) => `^${c}`), "--"]);
  const rows = stdout
    .toString("utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.split(" "));
  let start = head;
  let commits: string[] = [];
  for (const [commit, ...parents] of rows) {
    if (commit === undefined) continue;
    const [parent] = parents;
    if (parents.length !== 1 || parent === undefined) {
      // A merge (or a root): what comes before it stays as it is.
      start = commit;
      commits = [];
    } else if (commits.length === 0 || parent !== commits.at(-1)) {
      start = parent;
      commits = [commit];
    } else commits.push(commit);
  }
  if (commits.length > 0 && commits.at(-1) !== head) return { start: head, commits: [] };
  return { start, commits };
}

/**
 * A commit object like `raw`, on `parent`, with `message` instead of its own when given: the header keeps the tree,
 * author, committer and, with its own message, the encoding, and loses the parents and any signature, which would no
 * longer match.
 */
function withParent(raw: Buffer, parent: string, message: Buffer | null): Buffer {
  const split = raw.indexOf("\n\n");
  const header = (split === -1 ? raw : raw.subarray(0, split)).toString("latin1").split("\n");
  const body = split === -1 ? Buffer.alloc(0) : raw.subarray(split + 2);
  const kept: string[] = [];
  let dropping = false;
  for (const line of header) {
    // A continuation line belongs to the header line before it.
    if (line.startsWith(" ")) {
      if (!dropping) kept.push(line);
      continue;
    }
    dropping =
      line.startsWith("parent ") ||
      line.startsWith("gpgsig ") ||
      line.startsWith("gpgsig-sha256 ") ||
      line.startsWith("mergetag ") ||
      (message !== null && line.startsWith("encoding "));
    if (dropping) continue;
    kept.push(line);
    if (line.startsWith("tree ")) kept.push(`parent ${parent}`);
  }
  return Buffer.concat([Buffer.from(`${kept.join("\n")}\n\n`, "latin1"), message ?? body]);
}

async function writeCommit(own: OwnGit, object: Buffer, config: readonly string[]): Promise<string> {
  const { stdout } = await own(["hash-object", "-t", "commit", "-w", "--stdin"], { stdin: object, config });
  return stdout.toString("utf8").trim();
}
