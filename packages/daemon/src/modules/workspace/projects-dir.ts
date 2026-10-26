import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RepoId } from "@trackwall/protocol";
import { DomainError } from "../../infra/errors.ts";
import { isFullPath, NOT_FULL_PATH } from "./full-path.ts";
import { repoIdFor } from "./repo-id.ts";

/**
 * The projects folder (§4.5, ADR-18): a repo is every direct subdirectory with `.git` (a directory or a file,
 * as in a worktree). The folder is read on every query, so a repo cloned or removed outside Trackwall
 * appears and disappears without refreshing the configuration. We do not look deeper: the scan stays cheap and predictable.
 * The read is asynchronous, because the folder is sometimes on a network drive or a sleeping external drive.
 */

export interface RepoEntry {
  id: RepoId;
  /** The full path of the repo directory. */
  path: string;
}

/**
 * The full path of a folder to save in `workspace.yaml` (the projects folder, the task worktrees folder); it must exist,
 * so that a typo does not silently give an empty list or a worktree in an unexpected place.
 * Asynchronous, because the chosen folder may lie on a sleeping drive.
 */
export async function resolveFolderSetting(input: string): Promise<string> {
  const { path, isDir } = await statFullPath(input, NOT_FULL_PATH);
  if (!isDir) throw new DomainError("bad_request", `${path} is not a directory`);
  return path;
}

/**
 * A full path from the user that must exist (the projects folder, a dropped folder, ADR-51), resolved, with whether
 * it is a directory; `notFull` says what the path is for when it is not a full path.
 */
export async function statFullPath(input: string, notFull: string): Promise<{ path: string; isDir: boolean }> {
  if (!isFullPath(input)) throw new DomainError("bad_request", `${notFull}, got "${input}"`);
  const path = resolve(input);
  try {
    return { path, isDir: (await stat(path)).isDirectory() };
  } catch (err) {
    // Not only ENOENT: ENOTDIR, EACCES and a name that is too long are also a bad path from the user, not a daemon error.
    throw new DomainError("bad_request", `${path} does not exist or cannot be opened (${errorCode(err)})`);
  }
}

/**
 * Repos in the projects folder, sorted by directory name; the identifier comes from the name, on a collision with a suffix
 * in the same order (a new directory that sorts earlier may therefore take over an identifier, ADR-18).
 */
export async function findRepos(projectsDir: string, unreadable: Unreadable): Promise<RepoEntry[]> {
  const entries = (await listDir(projectsDir, unreadable)).filter((entry) => !entry.name.startsWith("."));
  const isRepo = await Promise.all(entries.map((entry) => isRepoDir(projectsDir, entry)));
  const taken = new Set<string>();
  return (
    entries
      .filter((_, i) => isRepo[i])
      .map((entry) => entry.name)
      // The `readdir` order depends on the file system; a fixed order gives fixed suffixes on collisions.
      .sort(byName)
      .map((name) => {
        const path = join(projectsDir, name);
        const id = repoIdFor(path, taken);
        taken.add(id);
        return { id, path };
      })
  );
}

/** The key of a name or path in the projects folder: Windows and macOS drives are case-insensitive. */
export function dirKey(name: string): string {
  return name.toLowerCase();
}

/** Whether the projects folder already has something (also a file or a hidden directory) with this name; a clone cannot go there. */
export async function takenNames(projectsDir: string): Promise<(name: string) => boolean> {
  const taken = new Set((await listDir(projectsDir, projectsDirUnavailable)).map((entry) => dirKey(entry.name)));
  return (name) => taken.has(dirKey(name));
}

/** The error for a folder that cannot be read, with the path and the system error code. */
export type Unreadable = (dir: string, code: string) => DomainError;

export const projectsDirUnavailable: Unreadable = (dir, code) =>
  new DomainError(
    "projects_dir_unavailable",
    `cannot open the projects folder ${dir} (${code}); check that it exists or change it in Settings`,
  );

async function listDir(dir: string, unreadable: Unreadable): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (err) {
    throw unreadable(dir, errorCode(err));
  }
}

/** A link (on Windows also a junction) to a directory counts as a directory; a broken link is skipped. */
async function isRepoDir(parent: string, entry: Dirent): Promise<boolean> {
  const dir = join(parent, entry.name);
  const isDir = entry.isDirectory() || (entry.isSymbolicLink() && (await stat(dir).catch(() => undefined))?.isDirectory() === true);
  return isDir && (await hasGit(dir));
}

/** A `.git` directory or file (as in a worktree) makes a directory a repo. */
export async function hasGit(dir: string): Promise<boolean> {
  return (await stat(join(dir, ".git")).catch(() => undefined)) !== undefined;
}

/** Without `localeCompare`: the order must not depend on the ICU data in Bun and Node. */
function byName(a: string, b: string): number {
  const [la, lb] = [a.toLowerCase(), b.toLowerCase()];
  if (la !== lb) return la < lb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function errorCode(err: unknown): string {
  return (err as NodeJS.ErrnoException).code ?? String(err);
}
