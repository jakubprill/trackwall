import { existsSync } from "node:fs";
import { readdir, rename, rmdir } from "node:fs/promises";
import { join } from "node:path";
import type { TrackwallFolder } from "@trackwall/protocol";
import { messageOf } from "./errors.ts";
import { ensureTrackwallDir, trackwallDir } from "./trackwall-dir.ts";

/**
 * The folders Trackwall kept in the projects folder before ADR-125, each moved into `.trackwall` by a rename on the same
 * drive, so nothing is copied. A move that fails (on Windows a program can hold a file in the folder open) is logged and
 * tried again at the next start; until then the old store stays in use (`localConfigStoreDir`). The task worktrees
 * folder is not moved: a git worktree knows its path and a session may work in it, so each task keeps the folder it
 * remembers, and the old folder goes once it is empty. This file goes when no installation has the old folders left.
 */

/** The folders of `.trackwall` that had a name of their own before ADR-125; later ones (the board, ADR-133) never did. */
type OldFolder = Exclude<TrackwallFolder, "board">;

/** Each folder of `.trackwall` under its name before ADR-125. */
const OLD_NAMES: Record<OldFolder, string> = {
  local: ".trackwall-local",
  worktrees: ".trackwall-worktrees",
  lsp: ".trackwall-lsp",
  scratch: ".trackwall-scratch",
  removed: ".trackwall-removed",
};

/** Folders of loose entries (a removed repo, a task's index, a temporary file), moved one entry at a time. */
const ENTRY_FOLDERS: readonly OldFolder[] = ["removed", "lsp", "scratch"];

export async function moveOldTrackwallFolders(projectsDir: string, log: (msg: string) => void): Promise<void> {
  await moveStore(projectsDir, log);
  for (const folder of ENTRY_FOLDERS) await moveEntries(projectsDir, folder, log);
}

/**
 * The local config store in the projects folder: in `.trackwall`, or in its old folder while that has not moved yet, so
 * that a failed move does not leave the backups in one repo and start a second.
 */
export function localConfigStoreDir(projectsDir: string): string {
  const dir = trackwallDir(projectsDir, "local");
  const old = join(projectsDir, OLD_NAMES.local);
  return !existsSync(dir) && existsSync(old) ? old : dir;
}

/** The default task worktrees folder before ADR-125. */
export function oldWorktreesDir(projectsDir: string): string {
  return join(projectsDir, OLD_NAMES.worktrees);
}

/**
 * The old default task worktrees folder once its tasks have ended: an ended task leaves its repo's folder empty, and
 * `rmdir` removes only empty folders, so a worktree in use stays. Not for a folder the user chose as `worktreesDir`.
 */
export async function removeEmptyWorktreesDir(dir: string): Promise<void> {
  const repos = await readdir(dir).catch(() => null);
  if (repos === null) return;
  for (const repo of repos) await rmdir(join(dir, repo)).catch(() => {});
  await rmdir(dir).catch(() => {});
}

/** The store is one git repo, with its history and remote, so it moves as a whole. */
async function moveStore(projectsDir: string, log: (msg: string) => void): Promise<void> {
  const old = join(projectsDir, OLD_NAMES.local);
  if (!existsSync(old)) return;
  const dir = trackwallDir(projectsDir, "local");
  if (existsSync(dir)) {
    log(`${old} stays where it is: ${dir} exists too; keep the one you want and delete the other`);
    return;
  }
  await moveLogged(old, dir, () => ensureTrackwallDir(projectsDir), log);
}

async function moveEntries(projectsDir: string, folder: OldFolder, log: (msg: string) => void): Promise<void> {
  const old = join(projectsDir, OLD_NAMES[folder]);
  const names = await readdir(old).catch(() => null);
  if (names === null) return;
  for (const name of names) {
    const target = join(trackwallDir(projectsDir, folder), name);
    if (existsSync(target)) log(`${join(old, name)} stays where it is: ${target} exists too`);
    else await moveLogged(join(old, name), target, () => ensureTrackwallDir(projectsDir, folder), log);
  }
  await rmdir(old).catch(() => {});
}

/** `makeParent` makes and checks the folder `to` goes into. */
async function moveLogged(from: string, to: string, makeParent: () => Promise<string>, log: (msg: string) => void): Promise<void> {
  try {
    await makeParent();
    await rename(from, to);
    log(`moved ${from} to ${to}`);
  } catch (err) {
    log(`${from} could not move to ${to}, trying again at the next start: ${messageOf(err)}`);
  }
}
