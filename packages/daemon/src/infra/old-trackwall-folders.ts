import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LANGUAGE_SERVER_DIR_NAME, LOCAL_CONFIG_STORE_DIR, REMOVED_REPOS_DIR, SCRATCH_DIR_NAME } from "@trackwall/protocol";
import { messageOf } from "./errors.ts";
import { trackwallDir } from "./trackwall-dir.ts";

/**
 * The folders Trackwall kept in the projects folder before ADR-125, each moved into `.trackwall` by a rename on the same
 * drive, so nothing is copied. A move that fails (on Windows a program can hold a file in the folder open) is logged and
 * tried again at the next start; until then the old folder keeps working where it matters. The task worktrees folder is
 * not moved: a git worktree knows its path and a session may work in it, so each task keeps the folder it remembers, and
 * the old folder goes once it is empty.
 */

/** The local config store before ADR-125; the store stays there until it moves (`localConfigStoreDir`). */
const OLD_LOCAL_CONFIG_STORE_DIR = ".trackwall-local";

/** The default task worktrees folder before ADR-125. */
export function oldWorktreesDir(projectsDir: string): string {
  return join(projectsDir, ".trackwall-worktrees");
}

/** Folders of loose entries (a removed repo, a task's index, a temporary file), moved one entry at a time. */
const OLD_ENTRY_FOLDERS: ReadonlyArray<readonly [old: string, name: string]> = [
  [".trackwall-removed", REMOVED_REPOS_DIR],
  [".trackwall-lsp", LANGUAGE_SERVER_DIR_NAME],
  [".trackwall-scratch", SCRATCH_DIR_NAME],
];

export async function moveOldTrackwallFolders(projectsDir: string, log: (msg: string) => void): Promise<void> {
  await moveStore(projectsDir, log);
  for (const [old, name] of OLD_ENTRY_FOLDERS) await moveEntries(join(projectsDir, old), trackwallDir(projectsDir, name), log);
}

/**
 * The local config store in the projects folder: in `.trackwall`, or in its old folder while that has not moved yet, so
 * that a failed move does not leave the backups in one repo and start a second.
 */
export function localConfigStoreDir(projectsDir: string): string {
  const dir = trackwallDir(projectsDir, LOCAL_CONFIG_STORE_DIR);
  const old = join(projectsDir, OLD_LOCAL_CONFIG_STORE_DIR);
  return !existsSync(dir) && existsSync(old) ? old : dir;
}

/** The store is one git repo, with its history and remote, so it moves as a whole. */
async function moveStore(projectsDir: string, log: (msg: string) => void): Promise<void> {
  const old = join(projectsDir, OLD_LOCAL_CONFIG_STORE_DIR);
  if (!existsSync(old)) return;
  const dir = trackwallDir(projectsDir, LOCAL_CONFIG_STORE_DIR);
  if (existsSync(dir)) {
    log(`${old} stays where it is: ${dir} exists too; keep the one you want and delete the other`);
    return;
  }
  await moveLogged(old, dir, log);
}

async function moveEntries(old: string, dir: string, log: (msg: string) => void): Promise<void> {
  const names = await readdir(old).catch(() => null);
  if (names === null) return;
  for (const name of names) {
    const target = join(dir, name);
    if (existsSync(target)) log(`${join(old, name)} stays where it is: ${target} exists too`);
    else await moveLogged(join(old, name), target, log);
  }
  await rmdir(old).catch(() => {});
}

async function moveLogged(from: string, to: string, log: (msg: string) => void): Promise<void> {
  try {
    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
    log(`moved ${from} to ${to}`);
  } catch (err) {
    log(`${from} could not move to ${to}, trying again at the next start: ${messageOf(err)}`);
  }
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
