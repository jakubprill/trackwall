import type { Stats } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

/**
 * The state of a repo's HEAD and refs read from the files in its git directory, without a `git` process (§4.5, ADR-63):
 * `HEAD`, `packed-refs` and the directories under `refs/`. A commit, checkout, reset, pull, fetch or a new branch changes
 * one of them (git writes `<name>.lock` and renames it over the ref, so the directory of a loose ref changes too), and
 * `git status` changes none of them, so comparing the key every second costs a few `stat` calls per repo and does not
 * see the UI's own reads. The working directory and the index are not read on purpose: the key is about commits.
 */

export interface GitState {
  /** Equal for two reads exactly when HEAD and the refs did not change in between (as far as the file system shows). */
  key: string;
  /** When HEAD last moved (`logs/HEAD`, without the reflog `HEAD`), for "recently used first". */
  usedMs: number;
}

/** A directory under `refs/` with its subdirectories, read again only when its modification time changes. */
interface RefsDir {
  mtimeMs: number;
  subdirs: string[];
}

export class GitStateReader {
  /** Subdirectories by directory path: a fetch of a remote with hundreds of loose refs does not cost a `readdir` every second. */
  private readonly refsDirs = new Map<string, RefsDir>();
  /** The ref HEAD points to, by the `HEAD` file and its key: the file is read again only after git rewrote it. */
  private readonly headRefs = new Map<string, { key: string; ref: string | null }>();

  /** The state of the repo in directory `repo`; `null` when it has no readable git directory (no `.git`, a broken `gitdir:`). */
  async read(repo: string): Promise<GitState | null> {
    const dirs = await gitDirs(repo);
    if (!dirs) return null;
    const head = await stat(join(dirs.gitDir, "HEAD")).catch(() => undefined);
    if (!head) return null;
    const ref = await this.headRef(join(dirs.gitDir, "HEAD"), fileKey(head));
    const [branch, packed, log, refs] = await Promise.all([
      ref === null ? undefined : stat(join(dirs.commonDir, ...ref.split("/"))).catch(() => undefined),
      stat(join(dirs.commonDir, "packed-refs")).catch(() => undefined),
      stat(join(dirs.gitDir, "logs", "HEAD")).catch(() => undefined),
      this.refsKeys(join(dirs.commonDir, "refs"), ""),
    ]);
    return {
      key: [
        `HEAD ${fileKey(head)}`,
        // The checked-out branch's own file: a commit renames a new file over it, which a coarse directory time may not show.
        `${ref ?? "detached"} ${branch ? fileKey(branch) : "-"}`,
        `packed-refs ${packed ? fileKey(packed) : "-"}`,
        ...refs,
      ].join("\n"),
      usedMs: (log ?? head).mtimeMs,
    };
  }

  /** `refs/heads/<branch>` from `ref: …` in HEAD, `null` for a detached HEAD or a ref outside `refs/`. */
  private async headRef(file: string, key: string): Promise<string | null> {
    const cached = this.headRefs.get(file);
    if (cached?.key === key) return cached.ref;
    const match = /^ref:\s*(refs\/\S+)\s*$/.exec(await readFile(file, "utf8").catch(() => ""));
    const ref = match?.[1] && !match[1].split("/").includes("..") ? match[1] : null;
    this.headRefs.set(file, { key, ref });
    return ref;
  }

  /** `refs/<path> <mtime>` of directory `dir` and of every directory under it, in a fixed order. */
  private async refsKeys(dir: string, path: string): Promise<string[]> {
    const info = await stat(dir).catch(() => undefined);
    if (!info?.isDirectory()) {
      this.refsDirs.delete(dir);
      return [];
    }
    let cached = this.refsDirs.get(dir);
    if (cached?.mtimeMs !== info.mtimeMs) {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      cached = {
        mtimeMs: info.mtimeMs,
        subdirs: entries
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .sort(),
      };
      this.refsDirs.set(dir, cached);
    }
    const nested = await Promise.all(cached.subdirs.map((name) => this.refsKeys(join(dir, name), `${path}/${name}`)));
    return [`refs${path} ${info.mtimeMs}`, ...nested.flat()];
  }
}

/** Size and file identity next to the time: a rename over the file gives a new identity even within one timestamp tick. */
function fileKey(info: Stats): string {
  return `${info.mtimeMs}:${info.size}:${info.ino}`;
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
