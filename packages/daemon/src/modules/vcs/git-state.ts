import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileKey } from "../../infra/file-key.ts";
import { mapLimit } from "../../infra/map-limit.ts";
import { gitDirs, headRefName, optionalKey, statIfExists } from "./git-dir.ts";

/**
 * The state of a repo's HEAD and refs read from the files in its git directory, without a `git` process (§4.5, ADR-63):
 * `HEAD`, the file of the branch it points to, `packed-refs`, the directories under `refs/` and, with the reftable ref
 * backend, `reftable/tables.list`. A commit, checkout, reset, pull, fetch or a new branch changes one of them (git writes
 * `<name>.lock` and renames it over the ref, so the directory of a loose ref changes too), and `git status` changes none
 * of them, so comparing the keys every second costs a few `stat` calls per repo and does not see the UI's own reads. The
 * working directory and the index are not read on purpose: the state is about commits.
 */

export interface GitState {
  /** Equal for two reads when HEAD (the file, the file of its branch, with reftable the ref tables) did not change in between. */
  head: string;
  /** Equal for two reads when no other ref changed in between (as far as the file system shows). */
  refs: string;
  /** When HEAD last moved (`logs/HEAD`, without the reflog `HEAD`), for "recently used first". */
  usedMs: number;
}

/** How many repos are read at once: a few `stat` calls each, but the folder can lie on a network drive. */
const READ_CONCURRENCY = 16;
/**
 * A directory listing is reused only when the directory's time is older than this at the moment of listing: on a file
 * system with coarse times (whole seconds on HFS+, FAT or some network shares) a subdirectory created in the same tick
 * would otherwise never be visited (git's "racy timestamp" rule).
 */
const RACY_MS = 2000;

/** A directory under `refs/` with its subdirectories, listed again only when its modification time changes. */
interface RefsDir {
  mtimeMs: number;
  subdirs: string[];
}

/** What the reads of one repo remember between comparisons. */
interface RepoCache {
  /** The ref HEAD points to, by the key of the `HEAD` file: the file is read again only after git rewrote it. */
  headRef?: { key: string; ref: string | null };
  refsDirs: Map<string, RefsDir>;
}

export class GitStateReader {
  /** By repo root; replaced at every `readAll`, so a repo that left the list and a deleted ref directory leave no entry. */
  private caches = new Map<string, RepoCache>();

  /**
   * The state of every repo in `repos`: `null` for one without a git directory (no `.git`, a broken `gitdir:`), `undefined`
   * for one whose files could not be read this time (a sharing violation on Windows, a network drive timing out), which
   * says nothing about whether it changed.
   */
  async readAll(repos: readonly string[]): Promise<Map<string, GitState | null | undefined>> {
    const next = new Map<string, RepoCache>();
    const states = await mapLimit(repos, READ_CONCURRENCY, async (repo) => {
      const previous = this.caches.get(repo);
      const cache: RepoCache = { headRef: previous?.headRef, refsDirs: new Map() };
      next.set(repo, cache);
      const state = await readRepo(repo, cache, previous?.refsDirs ?? new Map()).catch(() => undefined);
      return [repo, state] as const;
    });
    this.caches = next;
    return new Map(states);
  }
}

/**
 * What `git status` depends on in the git directory (ADR-141): HEAD and the refs as the repo watch reads them, and the
 * index, which staging, a commit and a `git status` that refreshes stat data rewrite. `undefined` without a git directory
 * or when a file cannot be read this time. Read afresh on every call, so it does not share the repo watch's memory.
 */
export async function gitDirKey(repo: string): Promise<string | undefined> {
  const dirs = await gitDirs(repo);
  if (!dirs) return undefined;
  const [state, index] = await Promise.all([readRepo(repo, { refsDirs: new Map() }, new Map()), statIfExists(join(dirs.gitDir, "index"))]);
  return state ? `${state.head}\n${state.refs}\nindex ${optionalKey(index)}` : undefined;
}

async function readRepo(repo: string, cache: RepoCache, previousDirs: ReadonlyMap<string, RefsDir>): Promise<GitState | null> {
  const dirs = await gitDirs(repo);
  if (!dirs) return null;
  const headFile = join(dirs.gitDir, "HEAD");
  const head = await statIfExists(headFile);
  if (!head) return null;
  const ref = await headRef(headFile, fileKey(head), cache);
  const [branch, packed, reftable, worktreeReftable, log, refs] = await Promise.all([
    ref === null ? undefined : statIfExists(join(dirs.commonDir, ...ref.split("/"))),
    statIfExists(join(dirs.commonDir, "packed-refs")),
    statIfExists(join(dirs.commonDir, "reftable", "tables.list")),
    // A worktree's own refs, HEAD among them, have a reftable of their own.
    dirs.gitDir === dirs.commonDir ? undefined : statIfExists(join(dirs.gitDir, "reftable", "tables.list")),
    stat(join(dirs.gitDir, "logs", "HEAD")).catch(() => undefined),
    refsKeys(join(dirs.commonDir, "refs"), "", previousDirs, cache.refsDirs),
  ]);
  return {
    // The checked-out branch's own file: a commit renames a new file over it, which a coarse directory time may not show.
    // With reftable every ref, the branch too, lives in `tables.list`, so any ref change there counts as HEAD moving.
    head: [
      `HEAD ${fileKey(head)}`,
      `${ref ?? "detached"} ${optionalKey(branch)}`,
      `reftable ${optionalKey(reftable)}`,
      `worktree reftable ${optionalKey(worktreeReftable)}`,
    ].join("\n"),
    // `packed-refs` can also hold the checked-out branch; a change there is reported as a ref change only.
    refs: [`packed-refs ${optionalKey(packed)}`, ...refs].join("\n"),
    usedMs: (log ?? head).mtimeMs,
  };
}

/** `refs/heads/<branch>` from `ref: …` in HEAD, `null` for a detached HEAD or a ref outside `refs/`; a failed read throws. */
async function headRef(file: string, key: string, cache: RepoCache): Promise<string | null> {
  if (cache.headRef?.key === key) return cache.headRef.ref;
  const text = await readFile(file, "utf8");
  const ref = headRefName(text) ?? null;
  cache.headRef = { key, ref };
  return ref;
}

/** `refs/<path> <mtime>` of directory `dir` and of every directory under it, in a fixed order. */
async function refsKeys(
  dir: string,
  path: string,
  previous: ReadonlyMap<string, RefsDir>,
  visited: Map<string, RefsDir>,
): Promise<string[]> {
  const info = await stat(dir).catch(() => undefined);
  if (!info?.isDirectory()) return [];
  const listedAt = Date.now();
  let listing = previous.get(dir);
  if (listing?.mtimeMs !== info.mtimeMs) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    listing = {
      mtimeMs: info.mtimeMs,
      subdirs: entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort(),
    };
  }
  // A listing from the same timestamp tick as a change could miss it, so it is listed again next time. The times come from
  // the drive's clock: a network share whose clock is behind ours by more than this loses the protection.
  if (listedAt - info.mtimeMs > RACY_MS) visited.set(dir, listing);
  const nested = await Promise.all(listing.subdirs.map((name) => refsKeys(join(dir, name), `${path}/${name}`, previous, visited)));
  return [`refs${path} ${info.mtimeMs}`, ...nested.flat()];
}
