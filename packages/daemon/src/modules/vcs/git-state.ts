import type { Stats } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { mapLimit } from "../../infra/map-limit.ts";

/**
 * The state of a repo's HEAD and refs read from the files in its git directory, without a `git` process (§4.5, ADR-63):
 * `HEAD`, the file of the branch it points to, `packed-refs`, the directories under `refs/` and, with the reftable ref
 * backend, `reftable/tables.list`. A commit, checkout, reset, pull, fetch or a new branch changes one of them (git writes
 * `<name>.lock` and renames it over the ref, so the directory of a loose ref changes too), and `git status` changes none
 * of them, so comparing the keys every second costs a few `stat` calls per repo and does not see the UI's own reads. The
 * working directory and the index are not read on purpose: the state is about commits.
 */

export interface GitState {
  /** Equal for two reads when HEAD (the file and the file of its branch) did not change in between. */
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

  /** The state of every repo in `repos`; `null` for one without a readable git directory (no `.git`, a broken `gitdir:`). */
  async readAll(repos: readonly string[]): Promise<Map<string, GitState | null>> {
    const next = new Map<string, RepoCache>();
    const states = await mapLimit(repos, READ_CONCURRENCY, async (repo) => {
      const previous = this.caches.get(repo);
      const cache: RepoCache = { headRef: previous?.headRef, refsDirs: new Map() };
      next.set(repo, cache);
      const state = await readRepo(repo, cache, previous?.refsDirs ?? new Map()).catch(() => null);
      return [repo, state] as const;
    });
    this.caches = next;
    return new Map(states);
  }
}

async function readRepo(repo: string, cache: RepoCache, previousDirs: ReadonlyMap<string, RefsDir>): Promise<GitState | null> {
  const dirs = await gitDirs(repo);
  if (!dirs) return null;
  const headFile = join(dirs.gitDir, "HEAD");
  const head = await stat(headFile).catch(() => undefined);
  if (!head) return null;
  const ref = await headRef(headFile, fileKey(head), cache);
  const [branch, packed, reftable, log, refs] = await Promise.all([
    ref === null ? undefined : stat(join(dirs.commonDir, ...ref.split("/"))).catch(() => undefined),
    stat(join(dirs.commonDir, "packed-refs")).catch(() => undefined),
    stat(join(dirs.commonDir, "reftable", "tables.list")).catch(() => undefined),
    stat(join(dirs.gitDir, "logs", "HEAD")).catch(() => undefined),
    refsKeys(join(dirs.commonDir, "refs"), "", previousDirs, cache.refsDirs),
  ]);
  return {
    // The checked-out branch's own file: a commit renames a new file over it, which a coarse directory time may not show.
    head: [`HEAD ${fileKey(head)}`, `${ref ?? "detached"} ${optionalKey(branch)}`].join("\n"),
    // `packed-refs` and `tables.list` can also hold the checked-out branch; a change there is reported as a ref change.
    refs: [`packed-refs ${optionalKey(packed)}`, `reftable ${optionalKey(reftable)}`, ...refs].join("\n"),
    usedMs: (log ?? head).mtimeMs,
  };
}

/** `refs/heads/<branch>` from `ref: …` in HEAD, `null` for a detached HEAD or a ref outside `refs/`; a failed read is not kept. */
async function headRef(file: string, key: string, cache: RepoCache): Promise<string | null> {
  if (cache.headRef?.key === key) return cache.headRef.ref;
  const text = await readFile(file, "utf8").catch(() => undefined);
  if (text === undefined) return null;
  const match = /^ref:\s*(refs\/\S+)\s*$/.exec(text);
  const ref = match?.[1] && !match[1].split("/").includes("..") ? match[1] : null;
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
  // A listing from the same timestamp tick as a change could miss it, so it is listed again next time.
  if (listedAt - info.mtimeMs > RACY_MS) visited.set(dir, listing);
  const nested = await Promise.all(listing.subdirs.map((name) => refsKeys(join(dir, name), `${path}/${name}`, previous, visited)));
  return [`refs${path} ${info.mtimeMs}`, ...nested.flat()];
}

/** Size and file identity next to the time: a rename over the file gives a new identity even within one timestamp tick. */
function fileKey(info: Stats): string {
  return `${info.mtimeMs}:${info.size}:${info.ino}`;
}

function optionalKey(info: Stats | undefined): string {
  return info ? fileKey(info) : "-";
}

/**
 * The git directory of the repo (with `HEAD`) and the common one (with `refs/` and `packed-refs`): both `.git` in a normal
 * clone; in a worktree `.git` is a file with `gitdir: <path>`, and that directory names the common one in `commondir`.
 */
async function gitDirs(repo: string): Promise<{ gitDir: string; commonDir: string } | null> {
  const dotGit = join(repo, ".git");
  const info = await stat(dotGit).catch(() => undefined);
  if (!info) return null;
  if (info.isDirectory()) return { gitDir: dotGit, commonDir: dotGit };
  const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(dotGit, "utf8").catch(() => ""));
  if (!pointer?.[1]) return null;
  const gitDir = relativeTo(repo, pointer[1]);
  const common = (await readFile(join(gitDir, "commondir"), "utf8").catch(() => "")).trim();
  return { gitDir, commonDir: common ? relativeTo(gitDir, common) : gitDir };
}

function relativeTo(base: string, path: string): string {
  return isAbsolute(path) ? path : resolve(base, path);
}
