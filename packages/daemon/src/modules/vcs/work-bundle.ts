import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { withoutUserInfo } from "@trackwall/protocol";
import { removeFolder, removeIfPresent } from "../../infra/remove-folder.ts";
import { borrowingGitDir } from "./borrowed-objects.ts";
import { git } from "./git.ts";
import type { IndexPlaces } from "./index-place.ts";
import { NO_HOOKS } from "./no-hooks.ts";
import { remoteAddress } from "./remote.ts";
import { copyIndex } from "./worktree-changes.ts";
import { listWorktrees } from "./worktree-list.ts";

/**
 * A repo's work that is on no remote as one `git bundle` (ADR-274, §4.29): its local branches, its stashes, the
 * detached HEAD of a worktree and, for every worktree with changed or new files, a commit of those files made beside the
 * worktree, all as refs of a scratch git directory, bundled without the objects any remote-tracking branch already has.
 * Nothing in the repo changes: the scratch directory borrows the repo's objects and takes the new ones (the files of
 * the changes), each worktree's changes are added to a copy of its index, and the refs live only in the scratch
 * directory. The bundle is verified there before it counts. Ignored files never go in: they are mostly secrets.
 */

/** The fixed author of the commits of uncommitted changes: Trackwall made them, not the user. */
const IDENTITY = ["user.name=Trackwall", "user.email=trackwall@localhost", "commit.gpgSign=false", NO_HOOKS];
/** Adding every changed file of a large worktree and bundling a repo that was never pushed take longer than a read. */
const BUNDLE_TIMEOUT_MS = 5 * 60_000;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const OBJECT_FORMATS = ["sha1", "sha256"] as const;
type ObjectFormat = (typeof OBJECT_FORMATS)[number];
/** The refs of the bundle that are not branches, so that a restore can tell them apart. */
const WORK_REF_PREFIX = "refs/trackwall";

/** A remote of the repo with an address to clone from, without a password or token in it. */
interface BundledRemote {
  name: string;
  url: string;
}

interface BundledWorktree {
  path: string;
  /** The checked-out branch as a full ref; `null` on a detached HEAD. */
  branch: string | null;
  /** The checked-out commit; `null` in a repo without commits. */
  head: string | null;
  /** The ref in the bundle of a commit with the worktree's changed and new files on top of `head`; `null` without changes. */
  changes: string | null;
}

/** What one repo's bundle holds, for the manifest of a work backup. */
export interface WorkBundle {
  objectFormat: ObjectFormat;
  remotes: BundledRemote[];
  /** Every local branch with its commit, also one a remote has, so that a restore can make it again. */
  branches: { name: string; commit: string }[];
  /** The stashes, newest first, each as a ref in the bundle. */
  stashes: { ref: string; message: string }[];
  worktrees: BundledWorktree[];
  /** The refs the bundle holds: the branches and refs under `WORK_REF_PREFIX` with objects on no remote. */
  refs: string[];
}

/**
 * Bundles the work of `dir` into the file `out` and verifies it; `null` when no ref has anything a remote lacks, so
 * there is nothing to bundle. `scratchDir` is an existing folder of the daemon's, `indexPlaces` finds each index.
 */
export async function bundleWork(dir: string, out: string, scratchDir: string, indexPlaces: IndexPlaces): Promise<WorkBundle | null> {
  const repo = await repoFacts(dir);
  const scratch = await mkdtemp(join(scratchDir, "work-bundle-"));
  try {
    await borrowingGitDir(scratch, repo.objects, repo.objectFormat);
    const objects = join(scratch, "objects");
    const listed = (await listWorktrees(dir)).filter((w) => w.readable);
    const worktrees: BundledWorktree[] = [];
    const refs: RefLine[] = [];
    for (const [i, w] of listed.entries()) {
      const changes = await changesCommit(w.path, w.head, objects, scratchDir, indexPlaces);
      const changesRef = `${WORK_REF_PREFIX}/changes/${i}`;
      if (changes !== null) refs.push({ ref: changesRef, commit: changes });
      // A detached HEAD is on no branch: without a ref its commits would not go into the bundle.
      if (w.branch === null && w.head !== null) refs.push({ ref: `${WORK_REF_PREFIX}/head/${i}`, commit: w.head });
      worktrees.push({ path: w.path, branch: w.branch, head: w.head, changes: changes === null ? null : changesRef });
    }
    const branches = await refList(dir, "refs/heads/");
    const stashes = (await stashList(dir)).map((s, i) => ({ ...s, ref: `${WORK_REF_PREFIX}/stash/${i}` }));
    const remoteTips = await refList(dir, "refs/remotes/");
    refs.push(
      ...branches.map((b) => ({ ref: b.name, commit: b.commit })),
      ...stashes.map((s) => ({ ref: s.ref, commit: s.commit })),
      ...remoteTips.map((r, i) => ({ ref: `refs/remotes/tip/${i}`, commit: r.commit })),
    );
    await writeRefs(scratch, refs);
    const bundled = await createBundle(scratch, out);
    if (bundled === null) return null;
    return {
      objectFormat: repo.objectFormat,
      remotes: await remotesOf(dir),
      branches,
      stashes: stashes.map(({ ref, message }) => ({ ref, message })),
      worktrees,
      refs: bundled,
    };
  } finally {
    // A leftover folder in the scratch folder harms nothing, so failing to remove it does not fail the backup.
    await removeFolder(scratch, removeIfPresent).catch(() => undefined);
  }
}

interface RefLine {
  ref: string;
  commit: string;
}

async function repoFacts(dir: string): Promise<{ objects: string; objectFormat: ObjectFormat }> {
  const out = (await git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-object-format"])).stdout.toString("utf8");
  const [commonDir, objectFormat] = out.trim().split(/\r?\n/);
  const format = OBJECT_FORMATS.find((f) => f === objectFormat);
  if (!commonDir || format === undefined) throw new Error(`${dir}: git gave no git directory or object format`);
  return { objects: join(commonDir, "objects"), objectFormat: format };
}

/**
 * A commit of the worktree's changed and new files on top of `head` (on the empty tree in a repo without commits),
 * made through a copy of the worktree's index with every change added, and written into `objects` of the scratch
 * directory; `null` when the worktree has no change. The worktree's own index and files are not touched.
 */
async function changesCommit(
  worktree: string,
  head: string | null,
  objects: string,
  scratchDir: string,
  indexPlaces: IndexPlaces,
): Promise<string | null> {
  const { index } = await indexPlaces.of(worktree);
  const tmp = join(scratchDir, `index-${randomUUID()}`);
  try {
    await copyIndex(index, tmp);
    const opts = { indexFile: tmp, objectDirectory: objects, timeoutMs: BUNDLE_TIMEOUT_MS };
    await git(worktree, ["add", "--all", "--", "."], opts);
    const tree = (await git(worktree, ["write-tree"], opts)).stdout.toString("utf8").trim();
    if (!OBJECT_ID.test(tree)) throw new Error(`${worktree}: git write-tree gave no tree`);
    if (head !== null) {
      const headTree = (await git(worktree, ["rev-parse", `${head}^{tree}`])).stdout.toString("utf8").trim();
      if (headTree === tree) return null;
    } else if ((await git(worktree, ["ls-tree", "--name-only", tree], opts)).stdout.length === 0) {
      return null;
    }
    const parents = head === null ? [] : ["-p", head];
    const message = `Uncommitted changes of ${worktree}`;
    const made = await git(worktree, ["commit-tree", tree, ...parents, "-m", message], { ...opts, config: IDENTITY });
    const commit = made.stdout.toString("utf8").trim();
    if (!OBJECT_ID.test(commit)) throw new Error(`${worktree}: git commit-tree gave no commit`);
    return commit;
  } finally {
    await Promise.all([tmp, `${tmp}.lock`].map((file) => rm(file, { force: true }).catch(() => {})));
  }
}

/** The refs under `prefix` with their commits (`refs/heads/` gives the branches). */
async function refList(dir: string, prefix: string): Promise<{ name: string; commit: string }[]> {
  const out = (await git(dir, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(objecttype)", prefix])).stdout.toString("utf8");
  return out
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.split("\0"))
    .filter(([name, commit, type]) => name && commit && OBJECT_ID.test(commit) && type === "commit")
    .map(([name, commit]) => ({ name: name ?? "", commit: commit ?? "" }));
}

/** The stashes, newest first, with their messages. */
async function stashList(dir: string): Promise<{ commit: string; message: string }[]> {
  const out = (await git(dir, ["stash", "list", "-z", "--format=%H %gs"])).stdout.toString("utf8");
  return out
    .split("\0")
    .filter((entry) => entry !== "")
    .map((entry) => ({ commit: entry.slice(0, entry.indexOf(" ")), message: entry.slice(entry.indexOf(" ") + 1) }))
    .filter((s) => OBJECT_ID.test(s.commit));
}

async function writeRefs(scratch: string, refs: readonly RefLine[]): Promise<void> {
  const stdin = Buffer.from(refs.map((r) => `update ${r.ref} ${r.commit}\n`).join(""));
  await git(scratch, [`--git-dir=${scratch}`, "update-ref", "--stdin"], { stdin });
}

/** What the bundle takes: the branches and the work refs, without anything the remote tips have. */
const BUNDLED_REVISIONS = ["--branches", `--glob=${WORK_REF_PREFIX}/*`, "--not", "--remotes"];

/**
 * `git bundle create` of `BUNDLED_REVISIONS`, then `git bundle verify`; the refs the bundle holds, or `null` when every
 * ref is already on a remote, since git refuses an empty bundle.
 */
async function createBundle(scratch: string, out: string): Promise<string[] | null> {
  const gitDir = `--git-dir=${scratch}`;
  const count = (await git(scratch, [gitDir, "rev-list", "--count", ...BUNDLED_REVISIONS], { timeoutMs: BUNDLE_TIMEOUT_MS })).stdout;
  if (Number(count.toString("utf8").trim()) === 0) return null;
  await git(scratch, [gitDir, "bundle", "create", "--quiet", out, ...BUNDLED_REVISIONS], { timeoutMs: BUNDLE_TIMEOUT_MS });
  await git(scratch, [gitDir, "bundle", "verify", "--quiet", out], { timeoutMs: BUNDLE_TIMEOUT_MS });
  const heads = (await git(scratch, [gitDir, "bundle", "list-heads", out])).stdout.toString("utf8");
  return heads
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.slice(line.indexOf(" ") + 1));
}

/** The repo's remotes with an address on a repo host, an HTTPS one without the user and token it may carry (`withoutUserInfo`). */
async function remotesOf(dir: string): Promise<BundledRemote[]> {
  const out = (await git(dir, ["config", "--get-regexp", "^remote\\..*\\.url$"], { okExitCodes: [1] })).stdout.toString("utf8");
  return out.split("\n").flatMap((line) => {
    const match = /^remote\.(.+)\.url (.+)$/.exec(line);
    if (!match?.[1] || !match[2] || remoteAddress(match[2]) === undefined) return [];
    return [{ name: match[1], url: withoutUserInfo(match[2]) }];
  });
}
