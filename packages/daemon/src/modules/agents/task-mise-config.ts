import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MiseConfigChange } from "@trackwall/protocol";
import { DomainError } from "../../infra/errors.ts";

/**
 * The mise config of a task worktree (§4.4, ADR-59): the files mise reads for the tasks and the environment of a run in
 * the worktree root, each with a hash of its content. These are the config files (also the local ones git ignores,
 * such as `mise.local.toml`, which the task changes do not show), `.tool-versions` and the file tasks. A task stores the
 * snapshot the user trusted, and mise tasks run in its worktree only while the current snapshot is the same. Files a
 * config names elsewhere (`task_config.includes`, `[env] _.source`, `_.file`) are not in it, like the build scripts a
 * task runs (§8). Names are matched without regard to case, as mise finds them on the case-insensitive file systems of
 * Windows and macOS.
 */

/** Path relative to the worktree root, with `/`, mapped to the SHA-256 of the file's content. */
export type MiseSnapshot = Record<string, string>;

/** A mise config file name: `mise.toml`, `.mise.toml`, `mise.local.toml`, `mise.dev.toml`, `.mise.dev.local.toml`… */
const CONFIG_NAME = /^\.?mise(\.[^/\\]+)?\.toml$/i;
/** Read in the worktree root besides the config files. */
const ROOT_FILE = /^\.tool-versions$/i;
/** Directories mise reads whole: `config.toml`, `conf.d/` and file tasks, or file tasks only (`mise-tasks`). */
const MISE_DIRS: readonly (readonly string[])[] = [["mise"], [".mise"], [".config", "mise"], ["mise-tasks"], [".mise-tasks"]];
/** A mise config is a few small files; more means a generated directory, and reading it every few seconds would be costly. */
const MAX_FILES = 500;
const MAX_BYTES = 8 * 1024 * 1024;
/** The longest path a task file stores (`StoredTask.trustedMiseConfig`). */
export const MAX_MISE_PATH = 1024;
/** The content of a changed file shown to the user before they trust it; a longer file is to be read in an editor. */
const MAX_SHOWN_BYTES = 64 * 1024;

interface Walk {
  readonly root: string;
  readonly files: Map<string, string>;
  bytes: number;
}

export async function readMiseConfig(worktree: string): Promise<MiseSnapshot> {
  const walk: Walk = { root: worktree, files: new Map(), bytes: 0 };
  await addMatching(walk, [], (name) => CONFIG_NAME.test(name) || ROOT_FILE.test(name));
  for (const dir of await dirsNamed(walk, [], [".config"])) await addMatching(walk, dir, (name) => CONFIG_NAME.test(name));
  for (const names of MISE_DIRS) for (const dir of await dirsNamed(walk, [], names)) await addTree(walk, dir);
  return Object.fromEntries([...walk.files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** A changed file of the config, before its content is read for the user (`shownContent`). */
export type MiseFileChange = Omit<MiseConfigChange, "content">;

/** What differs in `current` from `trusted`, sorted by path. */
export function miseConfigChanges(trusted: MiseSnapshot, current: MiseSnapshot): MiseFileChange[] {
  const paths = [...new Set([...Object.keys(trusted), ...Object.keys(current)])].sort();
  return paths.flatMap((path): MiseFileChange[] => {
    const before = trusted[path];
    const now = current[path];
    if (before === now) return [];
    if (before === undefined) return [{ path, change: "added" }];
    if (now === undefined) return [{ path, change: "removed" }];
    return [{ path, change: "modified" }];
  });
}

/**
 * The text of a file the user is asked to trust, so that they trust what they read and not only a file name; `null`
 * for a file too long to show or no longer there.
 */
export async function shownContent(worktree: string, path: string): Promise<string | null> {
  const full = join(worktree, ...path.split("/"));
  try {
    if ((await lstat(full)).size > MAX_SHOWN_BYTES) return null;
    return await readFile(full, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** One hash of a whole snapshot, so the UI can name the config the user saw (`trust-task-mise-config`). */
export function miseConfigDigest(snapshot: MiseSnapshot): string {
  return sha256(Buffer.from(JSON.stringify(Object.entries(snapshot))));
}

async function addMatching(walk: Walk, dir: readonly string[], wanted: (name: string) => boolean): Promise<void> {
  for (const entry of await entries(join(walk.root, ...dir))) {
    if (!entry.isDirectory() && wanted(entry.name)) await addFile(walk, [...dir, entry.name]);
  }
}

/**
 * The directories at `names` under `dir`, each segment matched without regard to case (a case-sensitive file system can
 * hold both `mise` and `Mise`). A linked directory is refused like a linked file.
 */
async function dirsNamed(walk: Walk, dir: readonly string[], names: readonly string[]): Promise<string[][]> {
  const [next, ...deeper] = names;
  if (next === undefined) return [[...dir]];
  const found: string[][] = [];
  for (const entry of await entries(join(walk.root, ...dir))) {
    if (entry.name.toLowerCase() !== next) continue;
    if (entry.isSymbolicLink()) throw symlink([...dir, entry.name]);
    if (entry.isDirectory()) found.push(...(await dirsNamed(walk, [...dir, entry.name], deeper)));
  }
  return found;
}

async function addTree(walk: Walk, dir: readonly string[]): Promise<void> {
  for (const entry of await entries(join(walk.root, ...dir))) {
    const path = [...dir, entry.name];
    await (entry.isDirectory() ? addTree(walk, path) : addFile(walk, path));
  }
}

/**
 * A symbolic link is refused: mise follows it, so its target is the config, and a target can change outside the
 * checked files or lie outside the worktree. The size is checked before the read, so a huge file is not read every poll.
 */
async function addFile(walk: Walk, path: readonly string[]): Promise<void> {
  if (walk.files.size >= MAX_FILES) throw tooLarge(`more than ${MAX_FILES} files`);
  const key = path.join("/");
  if (key.length > MAX_MISE_PATH) throw tooLarge(`a path longer than ${MAX_MISE_PATH} characters`);
  const full = join(walk.root, ...path);
  const stat = await lstat(full);
  if (stat.isSymbolicLink()) throw symlink(path);
  walk.bytes += stat.size;
  if (walk.bytes > MAX_BYTES) throw tooLarge(`more than ${MAX_BYTES / 1024 / 1024} MB`);
  walk.files.set(key, sha256(await readFile(full)));
}

/** Entries of a directory; a missing one (or a file in its place) has none. */
async function entries(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw err;
  }
}

function tooLarge(what: string): DomainError {
  return new DomainError("mise_unavailable", `the mise config of the task worktree has ${what}, which Trackwall does not check`);
}

function symlink(path: readonly string[]): DomainError {
  return new DomainError(
    "mise_unavailable",
    `the mise config of the task worktree has a symbolic link (${path.join("/")}), which Trackwall does not check`,
  );
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
