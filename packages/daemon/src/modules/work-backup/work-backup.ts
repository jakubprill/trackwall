import type { FileHandle } from "node:fs/promises";
import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { TRACKWALL_DIR, type TrackwallFolder, type UnpushedWork, WorkBackupInfo, type WorkBackupState } from "@trackwall/protocol";
import { DomainError, messageOf } from "../../infra/errors.ts";
import { openRegularFile } from "../../infra/regular-file.ts";
import { readStateFile, stateFormat, writeStateFile } from "../../infra/state-file.ts";
import { type ArchiveEntry, writeArchive } from "./archive.ts";
import { BACKUP_FORMAT, type BackupManifest, type BackupRepo, type BackupStateFile } from "./manifest.ts";

/**
 * The work backup (§4.29, ADR-274): one file with everything that lives only in the container's volume, so that
 * removing the volume, resetting Docker or a broken virtual disk loses nothing the user cannot get back. It holds, for
 * each repo with work on no remote (the list of ADR-162), a `git bundle` of that work (`vcs`), and Trackwall's own
 * files a new container would lack: the state files of tasks and their journal, and the board, knowledge, routines and
 * task templates of `.trackwall`. Not ignored files, sign-ins or builds. Only the last backup stays in the state folder,
 * replaced in one rename; it is the user's to download, so the copies live on their own computer, out of reach of the
 * agents in the container. One backup at a time.
 */

export const WORK_BACKUP_DIR = "work-backup";
const BACKUP_FILE = "work-backup.tar.gz";
/** The summary of the last backup, beside the folder in the state directory, as a state file of ADR-223. */
export const WORK_BACKUP_INFO_FILE = "work-backup.json";
/** A file of `.trackwall` larger than this is no board item or note; it would only make the backup slow. */
const MAX_STATE_FILE_BYTES = 20 * 1024 * 1024;
/** The folders of `.trackwall` a new container lacks and Trackwall cannot make again. */
const TRACKWALL_FOLDERS: readonly TrackwallFolder[] = ["board", "knowledge", "routines", "task-templates"];
/** The limit of a file download (ADR-188): the page holds the whole file in memory before it saves it. */
const MAX_DOWNLOAD_BYTES = 1024 ** 3;

/** What `vcs` bundles of one repo (`Vcs.bundleWork`); `null` when every ref is already on a remote. */
type BundleWork = (dir: string, out: string) => Promise<Omit<BackupRepo, "repo" | "path" | "entry"> | null>;

export interface WorkBackupDeps {
  inContainer: boolean;
  /** The daemon's state directory. */
  stateDir: string;
  /** The state files kept in the backup, by name in the state directory. */
  stateFiles: readonly string[];
  /** `workspace`: the repos with work on no remote, and where each is. */
  unpushedWork: () => Promise<UnpushedWork>;
  repoPath: (repo: string) => Promise<string>;
  projectsDir: () => Promise<string>;
  bundleWork: BundleWork;
  version: string;
  now: () => Date;
  log: (msg: string) => void;
}

/**
 * What the last backup holds, beside its file. Only a summary of the archive: a file that cannot be read shows "no
 * backup yet" until the next backup writes it again, and the archive stays where it is.
 */
export const WORK_BACKUP_INFO_FORMAT = stateFormat(WorkBackupInfo);

export class WorkBackup {
  readonly #deps: WorkBackupDeps;
  #running: Promise<WorkBackupInfo> | null = null;

  constructor(deps: WorkBackupDeps) {
    this.#deps = deps;
  }

  async state(): Promise<WorkBackupState> {
    return { inContainer: this.#deps.inContainer, last: await this.#last(), running: this.#running !== null };
  }

  /** A new backup in place of the last one; a call while one is being made gets that one. */
  async create(): Promise<WorkBackupInfo> {
    if (!this.#deps.inContainer)
      throw new DomainError(
        "bad_request",
        "a work backup is made only where Trackwall runs in a container: here the repos are on this computer's own disk",
      );
    this.#running ??= this.#make().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  /** The last backup, opened for download. */
  async download(): Promise<{ name: string; size: number; handle: FileHandle }> {
    const last = await this.#last();
    const opened = last && (await openRegularFile(join(this.#dir(), BACKUP_FILE), MAX_DOWNLOAD_BYTES));
    if (!last || !opened) throw new DomainError("not_found", "there is no work backup yet: make one first");
    return { name: last.fileName, ...opened };
  }

  #infoFile(): string {
    return join(this.#deps.stateDir, WORK_BACKUP_INFO_FILE);
  }

  #dir(): string {
    return join(this.#deps.stateDir, WORK_BACKUP_DIR);
  }

  async #last(): Promise<WorkBackupInfo | null> {
    const info = readStateFile(this.#infoFile(), WORK_BACKUP_INFO_FORMAT, (problem, aside) =>
      this.#deps.log(`work backup: ${problem}; the file moved to ${aside}`),
    );
    return info ?? null;
  }

  async #make(): Promise<WorkBackupInfo> {
    const createdAt = this.#deps.now();
    const dir = this.#dir();
    await mkdir(dir, { recursive: true });
    const work = join(dir, `next-${createdAt.getTime()}`);
    await rm(work, { recursive: true, force: true });
    await mkdir(work);
    try {
      const { repos, skipped } = await this.#bundles(work);
      const state = await this.#stateFiles();
      const manifest: BackupManifest = {
        format: BACKUP_FORMAT,
        createdAt: createdAt.toISOString(),
        version: this.#deps.version,
        projectsDir: await this.#deps.projectsDir(),
        repos,
        state: state.map(({ entry }) => entry),
      };
      const archive = join(work, BACKUP_FILE);
      const entries: ArchiveEntry[] = [
        { name: "manifest.json", data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
        ...repos.map((r) => ({ name: r.entry, file: bundleFile(work, r.entry) })),
        ...state.map(({ entry, file }) => ({ name: entry.entry, file })),
      ];
      await writeArchive(archive, entries, createdAt);
      const info: WorkBackupInfo = {
        fileName: backupFileName(createdAt),
        createdAt: createdAt.toISOString(),
        bytes: (await lstat(archive)).size,
        repos: repos.length,
        branches: repos.reduce((n, r) => n + r.refs.filter((ref) => ref.startsWith("refs/heads/")).length, 0),
        stashes: repos.reduce((n, r) => n + r.stashes.length, 0),
        changedWorktrees: repos.reduce((n, r) => n + r.worktrees.filter((w) => w.changes !== null).length, 0),
        stateFiles: state.length,
        skipped,
      };
      // The file first, then what it is: an info without its file would offer a download that fails.
      await rename(archive, join(dir, BACKUP_FILE));
      writeStateFile(this.#infoFile(), WORK_BACKUP_INFO_FORMAT, info);
      return info;
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** One bundle per repo with work on no remote, in the list's order; a repo git cannot read is named, not fatal. */
  async #bundles(work: string): Promise<{ repos: BackupRepo[]; skipped: WorkBackupInfo["skipped"] }> {
    const unpushed = await this.#deps.unpushedWork();
    const projectsDir = await this.#deps.projectsDir();
    const repos: BackupRepo[] = [];
    const skipped = unpushed.unreadable.map((u) => ({ repo: u.repo, message: u.message }));
    for (const { repo } of unpushed.repos) {
      const entry = `repos/${repos.length}.bundle`;
      try {
        const path = await this.#deps.repoPath(repo);
        const bundle = await this.#deps.bundleWork(path, bundleFile(work, entry));
        if (bundle !== null) repos.push({ repo, path: relative(projectsDir, path), entry, ...bundle });
      } catch (err) {
        skipped.push({ repo, message: messageOf(err) });
      }
    }
    return { repos, skipped };
  }

  /** The state files and the files of `.trackwall`'s folders that exist, each a regular file, never a link. */
  async #stateFiles(): Promise<{ entry: BackupStateFile; file: string }[]> {
    const found: { place: BackupStateFile["place"]; path: string; file: string }[] = [];
    for (const name of this.#deps.stateFiles) {
      const file = join(this.#deps.stateDir, name);
      if (await isSmallRegularFile(file)) found.push({ place: "state", path: name, file });
    }
    const projectsDir = await this.#deps.projectsDir();
    for (const folder of TRACKWALL_FOLDERS) {
      for (const path of await regularFilesIn(join(projectsDir, TRACKWALL_DIR), folder))
        found.push({ place: "projects", path: `${TRACKWALL_DIR}/${path}`, file: join(projectsDir, TRACKWALL_DIR, path) });
    }
    return found.map(({ place, path, file }, i) => ({ entry: { entry: `state/${i}`, place, path }, file }));
  }
}

/** `trackwall-backup-2026-11-18-1440.tar.gz`, in UTC like the container's clock. */
function backupFileName(at: Date): string {
  const iso = at.toISOString();
  return `trackwall-backup-${iso.slice(0, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}.tar.gz`;
}

/** Where a repo's bundle is written before it goes into the archive under `entry` (`repos/<n>.bundle`). */
function bundleFile(work: string, entry: string): string {
  return join(work, entry.replace("/", "-"));
}

async function isSmallRegularFile(file: string): Promise<boolean> {
  const info = await lstat(file).catch(() => undefined);
  return info?.isFile() === true && info.size <= MAX_STATE_FILE_BYTES;
}

/** The regular files under `base/folder`, as paths relative to `base` with `/`, without following links. */
async function regularFilesIn(base: string, folder: string): Promise<string[]> {
  const info = await lstat(join(base, folder)).catch(() => undefined);
  if (!info?.isDirectory()) return [];
  const files: string[] = [];
  for (const entry of await readdir(join(base, folder), { withFileTypes: true })) {
    const path = `${folder}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await regularFilesIn(base, path)));
    else if (entry.isFile() && (await isSmallRegularFile(join(base, path)))) files.push(path);
  }
  return files;
}
