import { createWriteStream } from "node:fs";
import { constants, copyFile, lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  MAX_WORK_BACKUP_BYTES,
  type RestoredFile,
  type RestoredRepo,
  TRACKWALL_DIR,
  type TrackwallFolder,
  type WorkBackupRestore,
} from "@trackwall/protocol";
import { DomainError, messageOf } from "../../infra/errors.ts";
import { entryFile } from "./archive.ts";
import { readArchive } from "./archive-reader.ts";
import { BackupManifest, type BackupRepo } from "./manifest.ts";
import { WORK_BACKUP_DIR } from "./work-backup.ts";

/**
 * Restoring a work backup (§4.29, ADR-275): the user uploads a file a backup made, sees what restoring it would do repo
 * by repo, and restores it. The file is untrusted input from outside: it is unpacked by `archive-reader.ts`, its
 * manifest parsed with its schema, every path in it checked to stay in the projects folder, and git checks every object
 * of a bundle (`vcs`). A restore only adds: branches, stashes and `.trackwall` files the repo or the projects folder
 * lacks, and the commits a branch is behind; nothing the user has is changed or removed, so restoring twice does nothing
 * the second time. A repo goes back into a clone the user made, never one Trackwall clones from an address in the file.
 * Trackwall's task list and journal stay in the file. One uploaded backup at a time, kept until it is discarded.
 */

const RESTORE_DIR = "restore";
const CURRENT = "current";
const MANIFEST = "manifest.json";
/** Bundles hold compressed objects, so a backup unpacks to little more than its own size; more is no work backup. */
const MAX_UNPACKED_BYTES = 4 * MAX_WORK_BACKUP_BYTES;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
/** The folders of `.trackwall` a backup holds (`work-backup.ts`), the only ones a restore writes into. */
const RESTORED_FOLDERS: readonly TrackwallFolder[] = ["board", "knowledge", "routines", "task-templates"];

/** What `vcs` restores of a repo; the plan without the repo's place. */
type RepoPlan = Pick<RestoredRepo, "branches" | "stashes" | "changes">;
type RestoreSource = Omit<BackupRepo, "repo" | "path" | "entry" | "remotes" | "refs">;

export interface WorkRestoreDeps {
  inContainer: boolean;
  stateDir: string;
  /** `workspace`: the repo of that identifier in the projects folder; throws when there is none. */
  repoPath: (repo: string) => Promise<string>;
  projectsDir: () => Promise<string>;
  planRestore: (dir: string, bundle: string, source: RestoreSource) => Promise<RepoPlan>;
  restoreWork: (dir: string, bundle: string, source: RestoreSource) => Promise<RepoPlan>;
  now: () => Date;
}

export class WorkRestore {
  readonly #deps: WorkRestoreDeps;
  #busy = false;

  constructor(deps: WorkRestoreDeps) {
    this.#deps = deps;
  }

  /** Keeps the backup file in `body` in place of the one uploaded before, and answers what restoring it would do. */
  async upload(body: AsyncIterable<Buffer>): Promise<WorkBackupRestore> {
    this.#refuseOutsideContainer();
    return this.#alone(async () => {
      const root = this.#root();
      await mkdir(root, { recursive: true });
      const next = join(root, `next-${this.#deps.now().getTime()}`);
      await rm(next, { recursive: true, force: true });
      await mkdir(next);
      try {
        const file = join(next, "upload.tar.gz");
        await pipeline(body, limited(MAX_WORK_BACKUP_BYTES), createWriteStream(file, { flags: "wx", mode: 0o600 }));
        const files = join(next, "files");
        await mkdir(files);
        const names = await readArchive(file, (name) => entryFile(files, name), MAX_UNPACKED_BYTES);
        const manifest = await readManifest(files, names);
        await rm(file, { force: true });
        await rm(join(root, CURRENT), { recursive: true, force: true });
        await rename(files, join(root, CURRENT));
        return this.#plan(manifest);
      } finally {
        await rm(next, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }

  /** What restoring the uploaded backup would do now; `null` when none is uploaded. */
  async plan(): Promise<WorkBackupRestore | null> {
    const manifest = await this.#manifest();
    return manifest && this.#plan(manifest);
  }

  /** Restores the uploaded backup and answers what it did: each repo that git refused says so and stops nothing else. */
  async restore(): Promise<WorkBackupRestore> {
    this.#refuseOutsideContainer();
    return this.#alone(async () => {
      const manifest = await this.#manifest();
      if (!manifest) throw new DomainError("not_found", "there is no uploaded backup to restore: upload one first");
      const repos: RestoredRepo[] = [];
      for (const repo of manifest.repos) repos.push(await this.#repo(repo, this.#deps.restoreWork));
      const files = await this.#files(manifest);
      for (const file of files.filter((f) => f.action === "create")) await this.#writeFile(manifest, file.path);
      return summary(manifest, repos, files);
    });
  }

  async discard(): Promise<Record<string, never>> {
    await this.#alone(() => rm(join(this.#root(), CURRENT), { recursive: true, force: true }));
    return {};
  }

  #root(): string {
    return join(this.#deps.stateDir, WORK_BACKUP_DIR, RESTORE_DIR);
  }

  #refuseOutsideContainer(): void {
    if (!this.#deps.inContainer)
      throw new DomainError("bad_request", "a work backup is restored only where Trackwall runs in a container, like it is made");
  }

  /** One upload, restore or discard at a time: each replaces or reads the whole uploaded backup. */
  async #alone<T>(job: () => Promise<T>): Promise<T> {
    if (this.#busy) throw new DomainError("bad_request", "a backup is being uploaded or restored right now; try again when it ends");
    this.#busy = true;
    try {
      return await job();
    } finally {
      this.#busy = false;
    }
  }

  async #manifest(): Promise<BackupManifest | null> {
    const dir = join(this.#root(), CURRENT);
    if (!(await lstat(dir).catch(() => undefined))?.isDirectory()) return null;
    return readManifest(dir, null);
  }

  async #plan(manifest: BackupManifest): Promise<WorkBackupRestore> {
    const repos: RestoredRepo[] = [];
    for (const repo of manifest.repos) repos.push(await this.#repo(repo, this.#deps.planRestore));
    return summary(manifest, repos, await this.#files(manifest));
  }

  /** One repo, planned or restored by `run`; a repo the projects folder lacks or git refuses says why. */
  async #repo(repo: BackupRepo, run: WorkRestoreDeps["planRestore"]): Promise<RestoredRepo> {
    const base = { repo: repo.repo, path: repo.path, remotes: repo.remotes, branches: [], stashes: [], changes: [] };
    const dir = await this.#deps.repoPath(repo.repo).catch(() => null);
    if (dir === null) return { ...base, state: "not-cloned", message: null };
    try {
      const bundle = entryFile(join(this.#root(), CURRENT), repo.entry);
      const plan = await run(dir, bundle, repo);
      return { ...base, ...plan, state: "ready", message: null };
    } catch (err) {
      return { ...base, state: "cannot-restore", message: messageOf(err) };
    }
  }

  /** The backup's `.trackwall` files against the projects folder: missing ones are made, the user's own stay. */
  async #files(manifest: BackupManifest): Promise<RestoredFile[]> {
    const projectsDir = await this.#deps.projectsDir();
    const current = join(this.#root(), CURRENT);
    const files: RestoredFile[] = [];
    for (const entry of manifest.state) {
      if (entry.place !== "projects") continue;
      const target = await safeTarget(projectsDir, entry.path);
      const mine = await lstat(target).catch(() => undefined);
      if (mine === undefined) files.push({ path: entry.path, action: "create" });
      else {
        const same = mine.isFile() && (await readFile(target)).equals(await readFile(entryFile(current, entry.entry)));
        files.push({ path: entry.path, action: same ? "unchanged" : "kept-yours" });
      }
    }
    return files;
  }

  async #writeFile(manifest: BackupManifest, path: string): Promise<void> {
    const entry = manifest.state.find((s) => s.place === "projects" && s.path === path);
    if (!entry) return;
    const projectsDir = await this.#deps.projectsDir();
    const target = await safeTarget(projectsDir, path);
    await mkdir(join(target, ".."), { recursive: true });
    // The folders are checked again after they were made: a link put there meanwhile would lead the copy elsewhere.
    await safeTarget(projectsDir, path);
    await copyFile(entryFile(join(this.#root(), CURRENT), entry.entry), target, constants.COPYFILE_EXCL);
  }
}

function summary(manifest: BackupManifest, repos: RestoredRepo[], files: RestoredFile[]): WorkBackupRestore {
  return {
    createdAt: manifest.createdAt,
    version: manifest.version,
    repos,
    files,
    stateFilesKept: manifest.state.filter((s) => s.place === "state").length,
  };
}

/**
 * The manifest of an unpacked backup in `dir`, parsed with its schema, with every entry it names unpacked beside it
 * (`names`, when they are known) and named once.
 */
async function readManifest(dir: string, names: readonly string[] | null): Promise<BackupManifest> {
  const file = join(dir, MANIFEST);
  const info = await lstat(file).catch(() => undefined);
  if (!info?.isFile() || info.size > MAX_MANIFEST_BYTES)
    throw new DomainError("bad_request", "this is not a Trackwall work backup: it has no manifest");
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new DomainError("bad_request", "this is not a Trackwall work backup: its manifest is not JSON");
  }
  const parsed = BackupManifest.safeParse(raw);
  if (!parsed.success)
    throw new DomainError("bad_request", "this backup was made by another version of Trackwall, or its manifest is damaged");
  const entries = [...parsed.data.repos.map((r) => r.entry), ...parsed.data.state.map((s) => s.entry)];
  if (new Set(entries).size !== entries.length) throw new DomainError("bad_request", "the backup's manifest names one entry twice");
  const outside = parsed.data.state.find((s) => s.place === "projects" && !isRestorablePath(s.path));
  if (outside)
    throw new DomainError("bad_request", `the backup holds a file outside .trackwall's folders: ${JSON.stringify(outside.path)}`);
  const missing = names === null ? [] : entries.filter((e) => !names.includes(e));
  if (missing.length > 0) throw new DomainError("bad_request", `the backup lacks ${missing.join(", ")}, which its manifest names`);
  return parsed.data;
}

/** A `.trackwall` file's path in a backup: only under one of the folders a backup holds, no segment that leaves it. */
function isRestorablePath(path: string): boolean {
  const segments = path.split("/");
  const [top, folder] = segments;
  const plain = segments.every((s) => s !== "" && s !== "." && s !== ".." && !/[\\:\0]/.test(s));
  return top === TRACKWALL_DIR && RESTORED_FOLDERS.some((f) => f === folder) && segments.length >= 3 && plain;
}

/** Where a `.trackwall` file of the backup goes in the projects folder; no link on the way, so it lands nowhere else. */
async function safeTarget(projectsDir: string, path: string): Promise<string> {
  if (!isRestorablePath(path))
    throw new DomainError("bad_request", `the backup holds a file outside .trackwall's folders: ${JSON.stringify(path)}`);
  let at = projectsDir;
  for (const segment of path.split("/")) {
    at = join(at, segment);
    const info = await lstat(at).catch(() => undefined);
    if (info?.isSymbolicLink()) throw new DomainError("bad_request", `${path} leads through a link in the projects folder`);
  }
  return at;
}

/** Passes at most `maxBytes` through; a larger upload fails before it fills the disk. */
function limited(maxBytes: number) {
  return async function* (source: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
    let seen = 0;
    for await (const chunk of source) {
      seen += chunk.length;
      if (seen > maxBytes)
        throw new DomainError("bad_request", `the file is larger than ${maxBytes} bytes, more than a work backup can be`);
      yield chunk;
    }
  };
}
