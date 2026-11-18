import { mkdtemp } from "node:fs/promises";
import { basename, join } from "node:path";
import type { RestoredBranch, RestoredChanges, RestoredStash } from "@trackwall/protocol";
import { removeFolder, removeIfPresent } from "../../infra/remove-folder.ts";
import { borrowingGitDir } from "./borrowed-objects.ts";
import { git } from "./git.ts";
import { NO_HOOKS } from "./no-hooks.ts";
import { WORK_REF_PREFIX } from "./work-bundle.ts";
import { listWorktrees } from "./worktree-list.ts";

/**
 * Brings a repo's work back from its bundle in a work backup (ADR-275, §4.29), the other half of `work-bundle.ts`. The
 * bundle comes from a file the user hands Trackwall, so git checks every object it brings (`transfer.fsckObjects`), and
 * nothing the repo has is ever lost or moved aside: a branch that is not there is made, one the backup is ahead of moves
 * forward, one that went another way stays as it is and the backup's commit gets a branch of its own under `restored/`.
 * Stashes join the stash list, and the uncommitted changes of a worktree come back as a branch under
 * `restored/changes/`, never into the files of a worktree. The plan is read in a scratch git directory that borrows the
 * repo's objects, so looking at it writes nothing into the repo; restoring reads the plan again in the repo itself, after
 * the bundle's objects came in, and changes it in one ref transaction.
 */

/** What a repo's entry of the manifest says about its bundle (`BackupRepo` without its place). */
export interface RestoreSource {
  objectFormat: string;
  /** The local branches as full refs with their commits, also those a remote has. */
  branches: readonly { name: string; commit: string }[];
  stashes: readonly { ref: string; message: string }[];
  worktrees: readonly { path: string; branch: string | null; head: string | null; changes: string | null }[];
}

export interface RestorePlan {
  branches: RestoredBranch[];
  stashes: RestoredStash[];
  changes: RestoredChanges[];
}

/** Where the bundle's refs land while a restore reads or applies them, never a ref of the user's. */
const LANDING = "refs/trackwall-restore";
/** The bundle's branches and work refs, each under `LANDING`. */
const LANDING_REFSPECS = [`+refs/heads/*:${LANDING}/heads/*`, `+${WORK_REF_PREFIX}/*:${LANDING}/work/*`];
/** Where the backup's commits get branches of their own when they cannot take the name they had. */
const RESTORED = "restored";
/** A bundle of a repo never pushed carries its whole history. */
const RESTORE_TIMEOUT_MS = 5 * 60_000;
const HEADS = "refs/heads/";

/** A git directory to run commands in: the repo itself, or a scratch one through `--git-dir`. */
interface Place {
  cwd: string;
  args: readonly string[];
}

/**
 * What restoring the bundle would do to the repo `dir`, read without writing into it. Throws with git's message when the
 * repo cannot take the bundle: another object format, or commits the bundle builds on that this clone lacks.
 */
export async function planRestore(dir: string, bundle: string, source: RestoreSource, scratchDir: string): Promise<RestorePlan> {
  await sameObjectFormat(dir, source.objectFormat);
  const scratch = await mkdtemp(join(scratchDir, "work-restore-"));
  try {
    const common = (await git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.toString("utf8").trim();
    await borrowingGitDir(scratch, join(common, "objects"), source.objectFormat);
    const place = { cwd: scratch, args: [`--git-dir=${scratch}`] };
    await fetchBundle(place, bundle);
    return (await planIn(dir, place, source)).plan;
  } finally {
    await removeFolder(scratch, removeIfPresent).catch(() => undefined);
  }
}

/** Restores the bundle into `dir` as `planRestore` would show it now, and answers the plan it carried out. */
export async function restoreWork(dir: string, bundle: string, source: RestoreSource): Promise<RestorePlan> {
  await sameObjectFormat(dir, source.objectFormat);
  const place = { cwd: dir, args: [] };
  try {
    await fetchBundle(place, bundle);
    const { plan, local } = await planIn(dir, place, source);
    await applyRefs(dir, plan, local);
    for (const stash of plan.stashes.toReversed()) {
      if (stash.action === "add" && stash.commit !== null)
        await git(dir, ["stash", "store", "-m", stash.message, stash.commit], { config: [NO_HOOKS] });
    }
    for (const branch of plan.branches.filter((b) => b.action === "fast-forward" && b.worktree !== null))
      await git(branch.worktree ?? dir, ["merge", "--ff-only", "--quiet", branch.commit], {
        config: [NO_HOOKS],
        timeoutMs: RESTORE_TIMEOUT_MS,
      });
    return plan;
  } finally {
    await dropLanding(dir);
  }
}

async function sameObjectFormat(dir: string, objectFormat: string): Promise<void> {
  const format = (await git(dir, ["rev-parse", "--show-object-format"])).stdout.toString("utf8").trim();
  if (format !== objectFormat) throw new Error(`the backup's repo used ${objectFormat} object names, this clone uses ${format}`);
}

/** The bundle's refs under `LANDING`, every object checked; fails when the place lacks a commit the bundle builds on. */
async function fetchBundle(place: Place, bundle: string): Promise<void> {
  const config = ["transfer.fsckObjects=true", "fetch.recurseSubmodules=false", "gc.auto=0", "maintenance.auto=false", NO_HOOKS];
  const args = [...place.args, "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--", bundle, ...LANDING_REFSPECS];
  await git(place.cwd, args, { config, timeoutMs: RESTORE_TIMEOUT_MS });
}

async function dropLanding(dir: string): Promise<void> {
  const landed = await refs({ cwd: dir, args: [] }, `${LANDING}/`);
  if (landed.size === 0) return;
  const stdin = Buffer.from([...landed.keys()].map((ref) => `delete ${ref}\n`).join(""));
  await git(dir, ["update-ref", "--stdin"], { stdin, config: [NO_HOOKS] });
}

/** What the repo has that the plan depends on, read where the bundle's objects are. */
interface Facts {
  place: Place;
  /** The repo's branches by short name, with their commits. */
  local: Map<string, string>;
  /** The branches checked out in a worktree, by short name, with the worktree and whether it has no tracked changes. */
  checkedOut: Map<string, { path: string; clean: boolean }>;
  /** The commits of the stash list. */
  stashed: Set<string>;
  /** The bundle's refs as they landed, by their name in the bundle. */
  landed: Map<string, string>;
}

/** The plan, with the repo's branches as it read them, which a restore's transaction checks against. */
async function planIn(dir: string, place: Place, source: RestoreSource): Promise<{ plan: RestorePlan; local: Map<string, string> }> {
  const facts = await factsOf(dir, place);
  const taken = new Set(facts.local.keys());
  const branches: RestoredBranch[] = [];
  for (const b of source.branches) branches.push(await planBranch(facts, b.name, b.commit, taken));
  const stashes = await Promise.all(source.stashes.map((s) => planStash(facts, s.ref, s.message)));
  const changes: RestoredChanges[] = [];
  for (const w of source.worktrees) {
    const planned = await planChanges(facts, w, taken);
    if (planned) changes.push(planned);
  }
  return { plan: { branches, stashes, changes }, local: facts.local };
}

async function factsOf(dir: string, place: Place): Promise<Facts> {
  const local = new Map([...(await refs({ cwd: dir, args: [] }, HEADS))].map(([ref, commit]) => [ref.slice(HEADS.length), commit]));
  const checkedOut = new Map<string, { path: string; clean: boolean }>();
  for (const w of await listWorktrees(dir)) {
    if (!w.readable || w.branch === null || !w.branch.startsWith(HEADS)) continue;
    const status = await git(w.path, ["status", "--porcelain", "--untracked-files=no"]);
    checkedOut.set(w.branch.slice(HEADS.length), { path: w.path, clean: status.stdout.length === 0 });
  }
  const stashList = (await git(dir, ["stash", "list", "--format=%H"])).stdout.toString("utf8");
  const stashed = new Set(stashList.split("\n").filter((line) => line !== ""));
  const landedRefs = await refs(place, `${LANDING}/`);
  const landed = new Map<string, string>();
  for (const [ref, commit] of landedRefs) {
    const name = ref.startsWith(`${LANDING}/heads/`)
      ? `${HEADS}${ref.slice(`${LANDING}/heads/`.length)}`
      : `${WORK_REF_PREFIX}/${ref.slice(`${LANDING}/work/`.length)}`;
    landed.set(name, commit);
  }
  return { place, local, checkedOut, stashed, landed };
}

/** A branch of the backup: made, moved forward, left as it is, or kept beside the repo's own under `restored/`. */
async function planBranch(facts: Facts, ref: string, commit: string, taken: Set<string>): Promise<RestoredBranch> {
  const name = await branchName(facts.place, ref);
  const missing = { name, commit, action: "missing" as const, target: null, worktree: null };
  if (!(await hasCommit(facts.place, commit))) return missing;
  const mine = facts.local.get(name);
  if (mine === undefined) {
    taken.add(name);
    return { name, commit, action: "create", target: name, worktree: null };
  }
  if (mine === commit || (await isAncestor(facts.place, commit, mine)))
    return { name, commit, action: "unchanged", target: name, worktree: null };
  const checkedOut = facts.checkedOut.get(name);
  if ((await isAncestor(facts.place, mine, commit)) && (checkedOut === undefined || checkedOut.clean))
    return { name, commit, action: "fast-forward", target: name, worktree: checkedOut?.path ?? null };
  return sideBranch(facts, name, commit, `${RESTORED}/${name}`, taken);
}

/** A branch under `restored/` for the backup's commit: one that already points there is reused, else a free name. */
async function sideBranch(facts: Facts, name: string, commit: string, wanted: string, taken: Set<string>): Promise<RestoredBranch> {
  for (let n = 1; ; n++) {
    const target = n === 1 ? wanted : `${wanted}-${n}`;
    if (facts.local.get(target) === commit) return { name, commit, action: "unchanged", target, worktree: null };
    if (!taken.has(target)) {
      await branchName(facts.place, `${HEADS}${target}`);
      taken.add(target);
      return { name, commit, action: "side-branch", target, worktree: null };
    }
  }
}

async function planStash(facts: Facts, ref: string, message: string): Promise<RestoredStash> {
  const commit = facts.landed.get(ref) ?? null;
  if (commit === null) return { message, commit, action: "missing" };
  return { message, commit, action: facts.stashed.has(commit) ? "unchanged" : "add" };
}

/**
 * A worktree's uncommitted changes, or the commit a detached worktree was on, as a branch under `restored/`; `null` for a
 * worktree on a branch without changes, which the branch itself brings back.
 */
async function planChanges(facts: Facts, w: RestoreSource["worktrees"][number], taken: Set<string>): Promise<RestoredChanges | null> {
  const commit = w.changes !== null ? (facts.landed.get(w.changes) ?? null) : w.branch === null ? w.head : null;
  if (w.changes === null && commit === null) return null;
  const kind = w.changes !== null ? "changes" : "head";
  if (commit === null || !(await hasCommit(facts.place, commit)))
    return { worktree: w.path, commit: null, action: "missing", target: null };
  const planned = await sideBranch(facts, kind, commit, `${RESTORED}/${kind}/${safeSegment(basename(w.path))}`, taken);
  return { worktree: w.path, commit, action: planned.action === "unchanged" ? "unchanged" : "create", target: planned.target };
}

/** Every new branch and forward move in one transaction, each checked against what the plan read (`local`). */
async function applyRefs(dir: string, plan: RestorePlan, local: ReadonlyMap<string, string>): Promise<void> {
  const lines: string[] = [];
  for (const b of plan.branches) {
    if ((b.action === "create" || b.action === "side-branch") && b.target) lines.push(`create ${HEADS}${b.target} ${b.commit}\n`);
    // A checked-out branch moves with its worktree's files, by a fast-forward merge after the transaction.
    const from = local.get(b.name);
    if (b.action === "fast-forward" && b.worktree === null && from !== undefined)
      lines.push(`update ${HEADS}${b.name} ${b.commit} ${from}\n`);
  }
  for (const c of plan.changes) if (c.action === "create" && c.target && c.commit) lines.push(`create ${HEADS}${c.target} ${c.commit}\n`);
  if (lines.length === 0) return;
  await git(dir, ["update-ref", "--stdin"], { stdin: Buffer.from(lines.join("")), config: [NO_HOOKS] });
}

/** The short name of a branch ref of the backup; a name git would refuse fails the repo, since the file is not one Trackwall wrote. */
async function branchName(place: Place, ref: string): Promise<string> {
  if (!ref.startsWith(HEADS)) throw new Error(`the backup names ${JSON.stringify(ref)} as a branch`);
  await git(place.cwd, [...place.args, "check-ref-format", ref]).catch(() => {
    throw new Error(`the backup names a branch git refuses: ${JSON.stringify(ref)}`);
  });
  return ref.slice(HEADS.length);
}

/** A worktree folder's name as one segment of a branch name. */
function safeSegment(name: string): string {
  const safe = name
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .replace(/\.\.+/g, ".");
  return safe === "" || safe.endsWith(".lock") ? "worktree" : safe;
}

async function refs(place: Place, prefix: string): Promise<Map<string, string>> {
  const out = (await git(place.cwd, [...place.args, "for-each-ref", "--format=%(refname)%00%(objectname)", prefix])).stdout.toString(
    "utf8",
  );
  const found = new Map<string, string>();
  for (const line of out.split("\n")) {
    const [ref, commit] = line.split("\0");
    if (ref && commit) found.set(ref, commit);
  }
  return found;
}

async function hasCommit(place: Place, commit: string): Promise<boolean> {
  const out = await git(place.cwd, [...place.args, "cat-file", "-t", commit], { okExitCodes: [1, 128] }).catch(() => undefined);
  return out?.stdout.toString("utf8").trim() === "commit";
}

/** Not `merge-base --is-ancestor`: it answers with its exit code, which the runner cannot tell from a git error. */
async function isAncestor(place: Place, ancestor: string, commit: string): Promise<boolean> {
  const out = await git(place.cwd, [...place.args, "rev-list", "--count", `^${commit}`, ancestor, "--"]);
  return out.stdout.toString("utf8").trim() === "0";
}
