import { constants } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  type Commit,
  LOCAL_CONFIG_FILES,
  LOCAL_CONFIG_STORE_DIR,
  type LocalConfigFileName,
  type LocalConfigFileState,
  type LocalConfigPush,
  type LocalConfigStore,
  type RepoLocalConfig,
} from "@trackwall/protocol";
import { DomainError, messageOf } from "../../infra/errors.ts";
import { fileKey } from "../../infra/file-key.ts";
import { lstatIfExists, readLocalConfigFile } from "./repo-files.ts";

/**
 * The `local-config` module (§4.13, ADR-86): the files a repo keeps outside git on purpose (`LOCAL_CONFIG_FILES`), backed
 * up into the local config store, `.trackwall-local` in the projects folder, as `<repo folder>/<file>`. The store is a git
 * repo the daemon commits to and, when it has a remote, pushes, so a file the user or an agent overwrote can be found in
 * its history and a new computer clones it. Every few seconds the daemon compares each repo's files by `stat`, reads only
 * the changed ones and copies a file whose content differs from the store's. A file that disappears from a repo stays in
 * the store, which is what makes the backup worth having: a new clone gets it back with "Restore". A file the repo's
 * commits have is not local config and is left alone.
 */

/** How often the repos' files are compared: a saved file is in the store within this time plus a commit. */
const CHECK_MS = 5000;

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
  commitBackups(dir: string, paths: readonly string[], message: string): Promise<boolean>;
  backupRemote(dir: string): Promise<string | null>;
  pushBackups(dir: string): Promise<boolean>;
  log(dir: string, limit: number): Promise<Commit[]>;
}

export interface LocalConfigDeps {
  repos: LocalConfigRepos;
  vcs: LocalConfigVcs;
  log: (msg: string) => void;
}

/** A file copied into the store: the repo folder's name and the file. */
interface Copied {
  repo: string;
  file: LocalConfigFileName;
}

export class LocalConfig {
  readonly #deps: LocalConfigDeps;
  /** The file key of every repo file at the last comparison, by full path; `null` for a missing file. */
  readonly #seen = new Map<string, string | null>();
  /** Files copied into the store whose commit failed; the next backup commits them with its own. */
  #uncommitted: Copied[] = [];
  /** The store's commits and pushes, one after another: two at once fight over `index.lock`. */
  #storeWork: Promise<unknown> = Promise.resolve();
  #timer: NodeJS.Timeout | undefined;
  /** A slow drive must not stack comparisons: the next one starts only after the previous one ended. */
  #checking: Promise<void> | undefined;
  #problem: string | null = null;
  #push: LocalConfigPush = { kind: "none" };

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

  /** Resolves once the store's commits and pushes started so far have ended, whatever their result. */
  async settled(): Promise<void> {
    await this.#storeWork.catch(() => {});
  }

  async store(): Promise<LocalConfigStore> {
    const dir = await this.#storeDir();
    if (dir === null) return { dir, lastBackup: null, remote: null, push: this.#push, problem: this.#problem };
    const isRepo = (await lstatIfExists(join(dir, ".git"))) !== undefined;
    const [lastBackup, remote] = isRepo ? await Promise.all([this.#lastBackup(dir), this.#deps.vcs.backupRemote(dir)]) : [null, null];
    return { dir, lastBackup, remote, push: this.#push, problem: this.#problem };
  }

  async repo(id: string): Promise<RepoLocalConfig> {
    const dir = await this.#deps.repos.repoPath(id);
    const store = await this.#storeDir();
    const read = await Promise.all(
      LOCAL_CONFIG_FILES.map(async (file) => ({
        file,
        inRepo: await readLocalConfigFile(join(dir, file)),
        inStore: store === null ? undefined : await readLocalConfigFile(storePath(store, dir, file)),
      })),
    );
    const present = read.filter((f) => f.inRepo !== undefined).map((f) => f.file);
    const tracked = await this.#deps.vcs.trackedPaths(dir, present);
    const ignored = await this.#deps.vcs.ignoredPaths(
      dir,
      present.filter((file) => !tracked.has(file)),
    );
    const files = read.map(({ file, inRepo, inStore }): LocalConfigFileState => {
      if (inRepo === undefined) return inStore === undefined ? { kind: "absent", file } : { kind: "missing", file };
      if (tracked.has(file)) return { kind: "tracked", file };
      const kind = inStore?.equals(inRepo) ? "backed_up" : "pending";
      return { kind, file, ignored: ignored.has(file) };
    });
    return { repo: id, files };
  }

  /**
   * Copies the files only the store has into the repo root, never over a file that appeared meanwhile, and has git ignore
   * them in this clone, so the restored files do not end up in a commit.
   */
  async restore(id: string): Promise<RepoLocalConfig> {
    const dir = await this.#deps.repos.repoPath(id);
    const store = await this.#storeDir();
    if (store === null) throw new DomainError("bad_request", "set the projects folder first");
    const missing = (await this.repo(id)).files.filter((f) => f.kind === "missing").map((f) => f.file);
    if (missing.length === 0) throw new DomainError("bad_request", `${id}: the local config store has nothing this repo lacks`);
    for (const file of missing) {
      // Read first, so a link planted in the store is refused instead of followed.
      await readLocalConfigFile(storePath(store, dir, file));
      await copyFile(storePath(store, dir, file), join(dir, file), constants.COPYFILE_EXCL);
    }
    await this.#ignoreUnignored(dir, missing);
    return this.repo(id);
  }

  /** Has git ignore, in this clone, the local config files the repo has that git neither tracks nor ignores. */
  async ignore(id: string): Promise<RepoLocalConfig> {
    const dir = await this.#deps.repos.repoPath(id);
    const present = (await this.repo(id)).files.flatMap((f) => (f.kind === "backed_up" || f.kind === "pending" ? [f.file] : []));
    await this.#ignoreUnignored(dir, present);
    return this.repo(id);
  }

  async #ignoreUnignored(dir: string, files: readonly string[]): Promise<void> {
    const ignored = await this.#deps.vcs.ignoredPaths(dir, files);
    const unignored = files.filter((file) => !ignored.has(file));
    if (unignored.length > 0) await this.#deps.vcs.excludeLocally(dir, unignored);
  }

  /** From a timer an exception would be an unhandled rejection, which ends the process under Node. */
  #tick(): void {
    this.backUp().catch((err: unknown) => this.#fail(messageOf(err)));
  }

  /** A problem is logged once, not every few seconds, and shown with the store until a backup finishes. */
  #fail(message: string): void {
    if (this.#problem !== message) this.#deps.log(`local config backup: ${message}`);
    this.#problem = message;
  }

  async #backUp(): Promise<void> {
    const store = await this.#storeDir();
    if (store === null) return;
    const copied: Copied[] = [];
    const problems: string[] = [];
    for (const entry of await this.#deps.repos.repoEntries()) {
      try {
        copied.push(...(await this.#backUpRepo(store, entry.path)));
      } catch (err) {
        problems.push(`${entry.id}: ${messageOf(err)}`);
      }
    }
    const toCommit = [...this.#uncommitted, ...copied];
    if (toCommit.length > 0) await this.#commit(store, toCommit);
    if (problems.length > 0) return this.#fail(problems.join("; "));
    this.#problem = null;
  }

  /** The repo's local config files that changed since the last comparison and differ from the store, copied into it. */
  async #backUpRepo(store: string, dir: string): Promise<Copied[]> {
    const changed: { file: LocalConfigFileName; key: string; content: Buffer }[] = [];
    for (const file of LOCAL_CONFIG_FILES) {
      const path = join(dir, file);
      const info = await lstatIfExists(path);
      const key = info ? fileKey(info) : null;
      if (this.#seen.has(path) && this.#seen.get(path) === key) continue;
      const content = await readLocalConfigFile(path);
      const inStore = await readLocalConfigFile(storePath(store, dir, file));
      if (key === null || content === undefined || inStore?.equals(content)) this.#seen.set(path, key);
      else changed.push({ file, key, content });
    }
    if (changed.length === 0) return [];
    const tracked = await this.#deps.vcs.trackedPaths(
      dir,
      changed.map((c) => c.file),
    );
    const copied: Copied[] = [];
    for (const { file, key, content } of changed) {
      if (!tracked.has(file)) {
        await this.#writeToStore(store, dir, file, content);
        copied.push({ repo: basename(dir), file });
      }
      this.#seen.set(join(dir, file), key);
    }
    return copied;
  }

  /** The repo's folder in the store must be a real folder: a link would send the copy anywhere on the disk. */
  async #writeToStore(store: string, dir: string, file: LocalConfigFileName, content: Buffer): Promise<void> {
    const folder = join(store, basename(dir));
    const info = await lstatIfExists(folder);
    if (info && !info.isDirectory()) throw new Error(`${folder} in the local config store is not a folder`);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, file), content);
  }

  /** Commits the copied files and pushes them in the background; a failed commit is retried with the next backup. */
  async #commit(store: string, files: Copied[]): Promise<void> {
    const work = this.#onStore(async () => {
      await this.#deps.vcs.ensureBackupRepo(store);
      const paths = [...new Set(files.map((f) => `${f.repo}/${f.file}`))];
      await this.#deps.vcs.commitBackups(store, paths, backupMessage(files));
    });
    try {
      await work;
      this.#uncommitted = [];
    } catch (err) {
      this.#uncommitted = files;
      throw err;
    }
    void this.#onStore(() => this.#pushStore(store));
  }

  async #pushStore(store: string): Promise<void> {
    const at = new Date().toISOString();
    try {
      if (await this.#deps.vcs.pushBackups(store)) this.#push = { kind: "ok", at };
    } catch (err) {
      const message = messageOf(err);
      if (this.#push.kind !== "failed" || this.#push.message !== message) this.#deps.log(`local config push: ${message}`);
      this.#push = { kind: "failed", at, message };
    }
  }

  #onStore<T>(job: () => Promise<T>): Promise<T> {
    const result = this.#storeWork.catch(() => {}).then(job);
    this.#storeWork = result;
    return result;
  }

  async #lastBackup(store: string): Promise<Commit | null> {
    const [last] = await this.#deps.vcs.log(store, 1);
    return last ?? null;
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

/** A repo's file in the store: under the name of the repo's folder, which stays the same when its identifier gets a suffix. */
function storePath(store: string, dir: string, file: LocalConfigFileName): string {
  return join(store, basename(dir), file);
}

/** `Back up orders-api: mise.local.toml; web: .worktreeinclude, mise.local.toml` */
function backupMessage(files: readonly Copied[]): string {
  const byRepo = new Map<string, Set<string>>();
  for (const { repo, file } of files) byRepo.set(repo, (byRepo.get(repo) ?? new Set()).add(file));
  const parts = [...byRepo].map(([repo, names]) => `${repo}: ${[...names].sort().join(", ")}`);
  return `Back up ${parts.sort().join("; ")}`;
}
