import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic-write.ts";
import { messageOf } from "./errors.ts";
import { type StateFormat, writtenByNewer } from "./state-file.ts";

/**
 * A copy of the state files before another Trackwall version uses them, and the way back to it (ADR-244). When the
 * daemon starts in a version other than the one that last started on this state directory, it copies the state files
 * (the formats of ADR-223) into `state-backups/<time>/` first, before any module reads them. When a state file was
 * written by a newer format than this version reads, as after going back to an older Trackwall, it puts back the
 * whole set it copied when it last left this version, so tasks and the files about them stay consistent instead of
 * one file being set aside. The files it replaces are in the copy it just took, so going back loses nothing. Runs
 * under the start lock with no daemon running (`main.ts`).
 */

export const STATE_BACKUPS_DIR = "state-backups";
/** The version that last started on the state directory, so the next start knows whether it changed. */
const LAST_VERSION_FILE = "last-version.json";
const BACKUP_FILE = "backup.json";
/** Backups kept; a set of state files is small, and ten version changes reach back weeks. */
export const STATE_BACKUPS_KEPT = 10;

/** The state files of the daemon, by file name in the state directory, with their formats. */
export type StateFiles = Readonly<Record<string, StateFormat<object>>>;

const LastVersion = z.object({ version: z.string().min(1) });

/** What a backup is: the version that wrote its files (`null` when a Trackwall before backups did) and the one after it. */
const BackupInfo = z.object({ from: z.string().min(1).nullable(), to: z.string().min(1), takenAt: z.iso.datetime() });
type BackupInfo = z.infer<typeof BackupInfo>;

export interface StateBackup extends BackupInfo {
  /** The backup's folder. */
  path: string;
}

export interface KeepStateOptions {
  home: string;
  version: string;
  files: StateFiles;
  now: () => Date;
  log: (msg: string) => void;
}

/**
 * Backs the state files up when the version changed, and goes back to the backup of this version when a newer one
 * left files it cannot read. A failure goes to `log` and leaves the start going, as it went before backups; the
 * version is not recorded then, so the next start tries again.
 */
export function keepStateAcrossVersions(o: KeepStateOptions): void {
  const dir = join(o.home, STATE_BACKUPS_DIR);
  const last = readLastVersion(dir);
  if (last === o.version) return;
  try {
    const backup = backUpState(o, last ?? null);
    if (backup !== null)
      o.log(`state files of Trackwall ${last ?? "(before backups)"} copied to ${backup.path} before ${o.version} reads them`);
    const newer = Object.entries(o.files).filter(([name, format]) => writtenByNewer(join(o.home, name), format));
    if (newer.length > 0) goBack(o, newer.map(([name]) => name).join(", "));
    pruneBackups(o.home, o.log);
    writeFileAtomic(join(dir, LAST_VERSION_FILE), `${JSON.stringify({ version: o.version })}\n`);
  } catch (err) {
    o.log(`backing up the state files: ${messageOf(err)}`);
  }
}

/** Copies the state files there are into a new backup; `null` when there are none, as on a first start. */
function backUpState(o: KeepStateOptions, from: string | null): StateBackup | null {
  const present = Object.keys(o.files).filter((name) => existsSync(join(o.home, name)));
  if (present.length === 0) return null;
  const takenAt = o.now().toISOString();
  const path = join(o.home, STATE_BACKUPS_DIR, takenAt.replace(/[:.]/g, "-"));
  mkdirSync(path, { recursive: true, mode: 0o700 });
  for (const name of present) copyFileSync(join(o.home, name), join(path, name));
  // Written last: a folder without it is a backup cut short, which `stateBackups` does not list.
  const info: BackupInfo = { from, to: o.version, takenAt };
  writeFileAtomic(join(path, BACKUP_FILE), `${JSON.stringify(info, null, 2)}\n`);
  return { ...info, path };
}

/** Puts back the newest backup this version's files went into, as long as this version reads all of it. */
function goBack(o: KeepStateOptions, newer: string): void {
  const backup = stateBackups(o.home).find(
    (b) => b.from === o.version && Object.entries(o.files).every(([name, format]) => !writtenByNewer(join(b.path, name), format)),
  );
  if (backup === undefined) {
    o.log(`${newer} written by a newer Trackwall, and no backup of ${o.version}'s state to go back to; they will be set aside`);
    return;
  }
  for (const name of Object.keys(o.files)) {
    const saved = join(backup.path, name);
    const target = join(o.home, name);
    if (existsSync(saved)) writeFileAtomic(target, readFileSync(saved, "utf8"));
    else rmSync(target, { force: true });
  }
  o.log(`${newer} written by a newer Trackwall: the state files ${o.version} left, as copied at ${backup.takenAt}, are back`);
}

/** The complete backups in the state directory, newest first. */
export function stateBackups(home: string): StateBackup[] {
  const dir = join(home, STATE_BACKUPS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      const info = readJson(join(path, BACKUP_FILE), BackupInfo);
      return info === undefined ? [] : [{ ...info, path }];
    })
    .sort((a, b) => b.takenAt.localeCompare(a.takenAt));
}

/** Removes all but the newest backups, and any folder a backup cut short left. */
function pruneBackups(home: string, log: (msg: string) => void): void {
  const dir = join(home, STATE_BACKUPS_DIR);
  const kept = new Set(
    stateBackups(home)
      .slice(0, STATE_BACKUPS_KEPT)
      .map((b) => b.path),
  );
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (!entry.isDirectory() || kept.has(path)) continue;
    try {
      rmSync(path, { recursive: true, force: true });
    } catch (err) {
      log(`removing the old state backup ${path}: ${messageOf(err)}`);
    }
  }
}

function readLastVersion(dir: string): string | undefined {
  return readJson(join(dir, LAST_VERSION_FILE), LastVersion)?.version;
}

/** A small JSON file of this module, `undefined` when it is missing or not what it should be. */
function readJson<T>(path: string, schema: z.ZodType<T>): T | undefined {
  try {
    const parsed = schema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
