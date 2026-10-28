import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  type Commit,
  LOCAL_CONFIG_FILES,
  LOCAL_CONFIG_STORE_DIR,
  type LocalConfigFileName,
  type LocalConfigFileState,
  type LocalConfigPush,
  type LocalConfigStore,
  MAX_LOCAL_CONFIG_BYTES,
  type RepoLocalConfig,
} from "@trackwall/protocol";
import { DomainError, messageOf } from "../../infra/errors.ts";
import { fileKey } from "../../infra/file-key.ts";
import { readRegularFile } from "../../infra/regular-file.ts";

/**
 * The `local-config` module (§4.13, ADR-86): the files a repo keeps outside git on purpose (`LOCAL_CONFIG_FILES`), backed
 * up into the local config store, `.trackwall-local` in the projects folder, as `<repo folder>/<file>`. The store is a git
 * repo the daemon commits to and, when it has a remote, pushes, so every version is in its history and a new computer
 * clones it. The store's last commit is the backup: every few seconds the daemon compares each repo's files by `stat`,
 * reads only the changed ones and commits those whose content differs from the last commit's. The repo's file wins: a
 * store that changed under the daemon (a pull, a projects folder moved) is compared again in full, and a file that differs
 * is committed on top. A file that disappears from a repo stays in the store, which is what makes the backup worth
 * having: a new clone gets it back with "Restore". A file the repo's commits have is not local config and is left alone.
 */

/** How often the repos' files are compared: a saved file is in the store within this time plus a commit. */
const CHECK_MS = 5000;
/** How long after a failed push the next one is tried: a remote that is down is not asked every few seconds. */
const PUSH_RETRY_MS = 60_000;

/** What `local-config` needs from `workspace`; wired in the facade. */
interface LocalConfigRepos {
  repoEntries(): Promise<{ id: string; path: string }[]>;
  repoPath(id: string): Promise<string>;
  /** `bad_request` while the projects folder is not set. */
  projectsDir(): Promise<string>;
}

/** What `local-config` needs from `vcs`; wired in the facade. */
interface LocalConfigVcs {
  trackedPaths(dir: string, paths: readonly string[]): Promise<Set<string>>;
  ignoredPaths(dir: string, paths: readonly string[]): Promise<Set<string>>;
  excludeLocally(dir: string, paths: readonly string[]): Promise<void>;
  ensureBackupRepo(dir: string): Promise<void>;
  commitBackups(dir: string, files: readonly { path: string; content: Buffer }[], message: string): Promise<boolean>;
  storeHead(dir: string): Promise<string | null>;
  readFiles(dir: string, commit: string, paths: readonly string[], maxBytes: number): Promise<Map<string, Buffer>>;
  backupRemote(dir: string): Promise<string | null>;
  pushBackups(dir: string): Promise<boolean>;
  log(dir: string, limit: number): Promise<Commit[]>;
}

export interface LocalConfigDeps {
  repos: LocalConfigRepos;
  vcs: LocalConfigVcs;
  log: (msg: string) => void;
  /** `PUSH_RETRY_MS` in the daemon; shorter in tests. */
  pushRetryMs?: number;
}

/** A repo's local config file that changed since the last comparison, with what was read. */
interface Changed {
  dir: string;
  file: LocalConfigFileName;
  key: string;
  content: Buffer;
}

export class LocalConfig {
  readonly #deps: LocalConfigDeps;
  /** The file key of every repo file at the last comparison, by full path; `null` for a missing file. */
  readonly #seen = new Map<string, string | null>();
  /** The store and its last commit the comparisons in `#seen` were made against. */
  #compared: { store: string; head: string | null } | undefined;
  #timer: NodeJS.Timeout | undefined;
  /** A slow drive must not stack comparisons: the next one starts only after the previous one ended. */
  #checking: Promise<void> | undefined;
  #problem: string | null = null;
  #push: LocalConfigPush = { kind: "none" };
  /** The store commit the last push took (or found no remote for); `undefined` at the start, since the last run may have ended before its push. */
  #pushed: string | undefined;
  #pushing: Promise<void> | undefined;

  constructor(deps: LocalConfigDeps) {
    this.#deps = deps;
  }

  /** The first backup at once, then every `intervalMs`. */
  start(intervalMs = CHECK_MS): void {
    if (this.#timer) return;
    this.#tick();
    this.#timer = setInterval(() => this.#tick(), intervalMs);
    this.#timer.unref();
  }

  close(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** One backup; a call during a running one gets that one instead of starting another. */
  backUp(): Promise<void> {
    this.#checking ??= this.#backUp().finally(() => {
      this.#checking = undefined;
    });
    return this.#checking;
  }

  /** Resolves once a running push has ended, whatever its result. */
  async settled(): Promise<void> {
    await this.#pushing;
  }

  async store(): Promise<LocalConfigStore> {
    const dir = await this.#storeDir();
    const base = { push: this.#push, problem: this.#problem };
    if (dir === null) return { dir, lastBackup: null, remote: null, ...base };
    const head = await this.#deps.vcs.storeHead(dir);
    const [lastBackup] = head === null ? [] : await this.#deps.vcs.log(dir, 1);
    return { dir, lastBackup: lastBackup ?? null, remote: await this.#deps.vcs.backupRemote(dir), ...base };
  }

  async repo(id: string): Promise<RepoLocalConfig> {
    const dir = await this.#deps.repos.repoPath(id);
    return this.#repoState(id, dir, await this.#backups([dir]));
  }

  /**
   * Every repo with a local config file or a backup of one (ADR-108), for the view of all the files: the store is read
   * once for all repos, and git runs only in the repos that have a file, so a projects folder of mostly repos without
   * local config costs one `stat` per file.
   */
  async repos(): Promise<RepoLocalConfig[]> {
    const entries = await this.#deps.repos.repoEntries();
    const inStore = await this.#backups(entries.map((e) => e.path));
    const withConfig = await Promise.all(
      entries.map(async (entry) => {
        const present = await Promise.all(LOCAL_CONFIG_FILES.map((file) => exists(join(entry.path, file))));
        const backedUp = LOCAL_CONFIG_FILES.some((file) => inStore.has(storePath(entry.path, file)));
        return present.some(Boolean) || backedUp ? [entry] : [];
      }),
    );
    // git's own budget (ADR-79) paces the repos with files, so they can all start at once; this takes the git slots ahead of
    // other reads for a moment, which is accepted because it runs only when Settings › Files opens.
    return Promise.all(withConfig.flat().map(({ id, path }) => this.#repoState(id, path, inStore)));
  }

  /** The repo's files against `inStore`, the store's last commit by store path. */
  async #repoState(id: string, dir: string, inStore: Map<string, Buffer>): Promise<RepoLocalConfig> {
    const read = await Promise.all(
      LOCAL_CONFIG_FILES.map(async (file) => ({ file, inRepo: await readRegularFile(join(dir, file), MAX_LOCAL_CONFIG_BYTES) })),
    );
    const present = read.filter((f) => f.inRepo !== undefined).map((f) => f.file);
    // A file deleted from the working directory is still the repo's while the index tracks it, so Restore never writes an
    // old local copy over a file the team has since committed, such as `mise.toml` (ADR-110).
    const asked = read.filter((f) => f.inRepo !== undefined || inStore.has(storePath(dir, f.file))).map((f) => f.file);
    const tracked = await this.#deps.vcs.trackedPaths(dir, asked);
    const ignored = await this.#deps.vcs.ignoredPaths(
      dir,
      present.filter((file) => !tracked.has(file)),
    );
    const files = read.map(({ file, inRepo }): LocalConfigFileState => {
      const backup = inStore.get(storePath(dir, file));
      if (tracked.has(file)) return { kind: "tracked", file };
      if (inRepo === undefined) return backup === undefined ? { kind: "absent", file } : { kind: "missing", file };
      return { kind: backup?.equals(inRepo) ? "backed_up" : "pending", file, ignored: ignored.has(file) };
    });
    return { repo: id, files };
  }

  /**
   * Writes the files only the store's last backup has into the repo root, never over a file that appeared meanwhile,
   * and has git ignore them in this clone, so the restored files do not end up in a commit.
   */
  async restore(id: string): Promise<RepoLocalConfig> {
    const dir = await this.#deps.repos.repoPath(id);
    if ((await this.#restoreInto(id, dir)) === null)
      throw new DomainError("bad_request", `${id}: the local config store has nothing this repo lacks`);
    return this.repo(id);
  }

  /**
   * Restore without a click, right after Trackwall cloned a repo into `dir` (ADR-114): a clone has none of the local config
   * files, so whatever the store keeps for its folder goes back in. Nothing to restore is the usual case, not an error.
   */
  async restoreCloned(dir: string): Promise<LocalConfigFileName[]> {
    // The store knows a repo only by its folder name (`storePath`), so the folder name also names it in errors.
    return (await this.#restoreInto(basename(dir), dir)) ?? [];
  }

  /** Writes the files only the store has into `dir` and has git ignore them; `null` when the store has nothing it lacks. */
  async #restoreInto(id: string, dir: string): Promise<LocalConfigFileName[] | null> {
    const inStore = await this.#backups([dir]);
    const missing = (await this.#repoState(id, dir, inStore)).files.flatMap((f) => (f.kind === "missing" ? [f.file] : []));
    if (missing.length === 0) return null;
    const written: LocalConfigFileName[] = [];
    try {
      try {
        for (const file of missing) if (await writeNew(join(dir, file), inStore.get(storePath(dir, file)))) written.push(file);
      } finally {
        // A file written before a failure is in the repo all the same, so git must ignore it.
        await this.#ignoreUnignored(dir, written);
      }
    } catch (err) {
      throw new DomainError("repo_unavailable", `${id}: ${messageOf(err)}`);
    }
    return written;
  }

  /** Has git ignore, in this clone, the local config files the repo has that git neither tracks nor ignores. */
  async ignore(id: string): Promise<RepoLocalConfig> {
    const dir = await this.#deps.repos.repoPath(id);
    const present = (await this.repo(id)).files.flatMap((f) => (f.kind === "backed_up" || f.kind === "pending" ? [f.file] : []));
    await this.#ignoreUnignored(dir, present);
    return this.repo(id);
  }

  /** The local config files of the repos in `dirs` in the store's last commit, by store path (`storePath`). */
  async #backups(dirs: readonly string[]): Promise<Map<string, Buffer>> {
    const store = await this.#storeDir();
    const head = store === null ? null : await this.#deps.vcs.storeHead(store);
    if (store === null || head === null || dirs.length === 0) return new Map();
    const paths = dirs.flatMap((dir) => LOCAL_CONFIG_FILES.map((file) => storePath(dir, file)));
    return this.#deps.vcs.readFiles(store, head, paths, readLimit(paths.length));
  }

  async #ignoreUnignored(dir: string, files: readonly string[]): Promise<void> {
    const ignored = await this.#deps.vcs.ignoredPaths(dir, files);
    const unignored = files.filter((file) => !ignored.has(file));
    if (unignored.length > 0) await this.#deps.vcs.excludeLocally(dir, unignored);
  }

  /** From a timer an exception would be an unhandled rejection, which ends the process under Node. */
  #tick(): void {
    this.backUp().catch((err: unknown) => this.#setProblems([messageOf(err)]));
  }

  /** A problem is logged once, not every few seconds, and shown with the store until a backup has none. */
  #setProblems(problems: readonly string[]): void {
    const message = problems.length === 0 ? null : problems.join("; ");
    if (message !== null && message !== this.#problem) this.#deps.log(`local config backup: ${message}`);
    this.#problem = message;
  }

  async #backUp(): Promise<void> {
    const store = await this.#storeDir();
    if (store === null) return;
    const head = await this.#deps.vcs.storeHead(store);
    if (this.#compared?.store !== store || this.#compared.head !== head) this.#seen.clear();
    this.#compared = { store, head };
    const problems: string[] = [];
    const changed: Changed[] = [];
    for (const entry of await this.#deps.repos.repoEntries()) {
      try {
        changed.push(...(await this.#changedFiles(entry.path, problems)));
      } catch (err) {
        problems.push(`${entry.id}: ${messageOf(err)}`);
      }
    }
    try {
      await this.#commit(store, head, changed, problems);
    } catch (err) {
      problems.push(messageOf(err));
    }
    this.#setProblems(problems);
    this.#pushIfDue(store, await this.#deps.vcs.storeHead(store));
  }

  /**
   * The repo's local config files whose key changed since the last comparison; a missing one is noted and left out, and
   * one that cannot be read is a problem that does not hold up the repo's other file.
   */
  async #changedFiles(dir: string, problems: string[]): Promise<Changed[]> {
    const changed: Changed[] = [];
    for (const file of LOCAL_CONFIG_FILES) {
      const path = join(dir, file);
      try {
        const found = await this.#changedFile(path);
        if (found) changed.push({ dir, file, ...found });
      } catch (err) {
        problems.push(`${path}: ${messageOf(err)}`);
      }
    }
    return changed;
  }

  async #changedFile(path: string): Promise<{ key: string; content: Buffer } | undefined> {
    const info = await lstat(path).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return undefined;
      throw err;
    });
    const key = info ? fileKey(info) : null;
    if (this.#seen.has(path) && this.#seen.get(path) === key) return undefined;
    const content = await readRegularFile(path, MAX_LOCAL_CONFIG_BYTES);
    if (key !== null && content !== undefined) return { key, content };
    this.#seen.set(path, null);
    return undefined;
  }

  /**
   * Commits the changed files whose content differs from the last commit and that the repo does not track, then writes
   * them into the store's folder for the user to browse. A file is marked as compared only once its commit is made, so a
   * failed commit is tried again with the next backup.
   */
  async #commit(store: string, head: string | null, changed: readonly Changed[], problems: string[]): Promise<void> {
    if (changed.length === 0) return;
    const paths = changed.map((c) => storePath(c.dir, c.file));
    const inStore = head === null ? new Map<string, Buffer>() : await this.#deps.vcs.readFiles(store, head, paths, readLimit(paths.length));
    const differing = changed.filter((c) => !inStore.get(storePath(c.dir, c.file))?.equals(c.content));
    const toBackUp = await this.#untracked(differing);
    if (toBackUp.length > 0) {
      await this.#deps.vcs.ensureBackupRepo(store);
      const files = toBackUp.map((c) => ({ path: storePath(c.dir, c.file), content: c.content }));
      await this.#deps.vcs.commitBackups(store, files, backupMessage(toBackUp));
      this.#compared = { store, head: await this.#deps.vcs.storeHead(store) };
      for (const file of files) await writeStoreCopy(store, file.path, file.content).catch((err: unknown) => problems.push(messageOf(err)));
    }
    for (const c of changed) this.#seen.set(join(c.dir, c.file), c.key);
  }

  /** The files whose repo does not track them, asking git once per repo. */
  async #untracked(changed: readonly Changed[]): Promise<Changed[]> {
    const byRepo = new Map<string, Changed[]>();
    for (const c of changed) byRepo.set(c.dir, [...(byRepo.get(c.dir) ?? []), c]);
    const untracked: Changed[] = [];
    for (const [dir, files] of byRepo) {
      const tracked = await this.#deps.vcs.trackedPaths(
        dir,
        files.map((c) => c.file),
      );
      untracked.push(...files.filter((c) => !tracked.has(c.file)));
    }
    return untracked;
  }

  /** One push at a time, in the background, so a hanging remote never holds up the next backup. */
  #pushIfDue(store: string, head: string | null): void {
    if (head === null || head === this.#pushed || this.#pushing) return;
    const retryMs = this.#deps.pushRetryMs ?? PUSH_RETRY_MS;
    if (this.#push.kind === "failed" && Date.now() - Date.parse(this.#push.at) < retryMs) return;
    this.#pushing = this.#pushStore(store, head).finally(() => {
      this.#pushing = undefined;
    });
  }

  async #pushStore(store: string, head: string): Promise<void> {
    try {
      await this.#deps.vcs.ensureBackupRepo(store);
      if (await this.#deps.vcs.pushBackups(store)) this.#push = { kind: "ok", at: new Date().toISOString() };
      this.#pushed = head;
    } catch (err) {
      const message = messageOf(err);
      if (this.#push.kind !== "failed" || this.#push.message !== message) this.#deps.log(`local config push: ${message}`);
      this.#push = { kind: "failed", at: new Date().toISOString(), message };
    }
  }

  async #storeDir(): Promise<string | null> {
    try {
      return join(await this.#deps.repos.projectsDir(), LOCAL_CONFIG_STORE_DIR);
    } catch (err) {
      if (err instanceof DomainError && err.code === "bad_request") return null;
      throw err;
    }
  }
}

/** A repo's file in the store, with `/`: under the name of the repo's folder, which stays when its identifier gets a suffix. */
function storePath(dir: string, file: LocalConfigFileName): string {
  return `${basename(dir)}/${file}`;
}

/** Room for `count` files at the size limit and `cat-file`'s header lines. */
function readLimit(count: number): number {
  return count * (MAX_LOCAL_CONFIG_BYTES + 128);
}

/**
 * The copy in the store's folder for the user to browse; the commit already holds the content. Written to a new file and
 * renamed over the old one, and only in a real folder, never through a link planted in the store.
 */
async function writeStoreCopy(store: string, path: string, content: Buffer): Promise<void> {
  const [repo = "", file = ""] = path.split("/");
  const folder = join(store, repo);
  await mkdir(folder, { recursive: true });
  if (!(await lstat(folder)).isDirectory()) throw new Error(`${folder} in the local config store is not a folder`);
  const temp = join(folder, `.${file}.${randomUUID()}.tmp`);
  await writeFile(temp, content, { flag: "wx" });
  // On Windows a rename fails while an editor holds the old file open; the next backup of the file writes it again.
  await rename(temp, join(folder, file)).catch(async (err: unknown) => {
    await rm(temp, { force: true });
    throw err;
  });
}

/** Whether anything is at `path`; a file that cannot be checked counts as there, so its repo is shown with the reason. */
async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    (err: NodeJS.ErrnoException) => err.code !== "ENOENT",
  );
}

/** Writes `content` to a file that must not exist yet; `false` when one appeared meanwhile, which stays as it is. */
async function writeNew(path: string, content: Buffer | undefined): Promise<boolean> {
  if (content === undefined) return false;
  try {
    await writeFile(path, content, { flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/** `Back up orders-api: mise.local.toml; web: .worktreeinclude, mise.local.toml` */
function backupMessage(files: readonly Changed[]): string {
  const byRepo = new Map<string, Set<string>>();
  for (const { dir, file } of files) byRepo.set(basename(dir), (byRepo.get(basename(dir)) ?? new Set()).add(file));
  const parts = [...byRepo].map(([repo, names]) => `${repo}: ${[...names].sort().join(", ")}`);
  return `Back up ${parts.sort().join("; ")}`;
}
