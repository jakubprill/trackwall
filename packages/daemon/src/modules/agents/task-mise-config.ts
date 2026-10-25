import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import type { MiseConfigChange, TaskMiseConfig } from "@trackwall/protocol";
import { DomainError } from "../../infra/errors.ts";
import { isInside } from "../../infra/path-inside.ts";

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
  /** The real path of the root, which a symbolic link must stay under. */
  readonly realRoot: string;
  readonly files: Map<string, Buffer>;
  bytes: number;
}

/** The mise files of a worktree with their content, sorted by path. */
async function readMiseFiles(worktree: string): Promise<Map<string, Buffer>> {
  const walk: Walk = { root: worktree, realRoot: await realpath(worktree), files: new Map(), bytes: 0 };
  await addMatching(walk, [], (name) => CONFIG_NAME.test(name) || ROOT_FILE.test(name));
  for (const dir of await dirsNamed(walk, [], [".config"])) await addMatching(walk, dir, (name) => CONFIG_NAME.test(name));
  for (const names of MISE_DIRS) for (const dir of await dirsNamed(walk, [], names)) await addTree(walk, dir);
  return new Map([...walk.files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export async function readMiseConfig(worktree: string): Promise<MiseSnapshot> {
  return snapshotOf(await readMiseFiles(worktree));
}

/**
 * The worktree's mise config against `trusted` (`null`: never trusted), for the user to review: the text of each changed
 * file comes from the same read as the digest, so the digest the user trusts names the text they read.
 */
export async function reviewMiseConfig(worktree: string, trusted: MiseSnapshot | null): Promise<TaskMiseConfig> {
  const files = await readMiseFiles(worktree);
  const current = snapshotOf(files);
  const changes = miseConfigChanges(trusted ?? {}, current).map((c): MiseConfigChange => {
    const content = files.get(c.path);
    return { ...c, content: content === undefined || content.length > MAX_SHOWN_BYTES ? null : content.toString("utf8") };
  });
  return { neverTrusted: trusted === null, changes, digest: miseConfigDigest(current) };
}

function snapshotOf(files: Map<string, Buffer>): MiseSnapshot {
  return Object.fromEntries([...files].map(([path, content]) => [path, sha256(content)]));
}

/** A changed file before its text is added for the user (`reviewMiseConfig`). */
type MiseFileChange = Omit<MiseConfigChange, "content">;

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
    if (entry.isSymbolicLink()) throw unchecked([...dir, entry.name], "a linked directory");
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
 * mise follows a symbolic link, so a linked file counts by the content of its target, and only a target inside the
 * worktree (a repo that keeps `mise.toml` in a subdirectory); one outside could change unseen or be any file of the
 * user. Only regular files are read (a FIFO would block the read for good), and the size is checked before the read,
 * so a huge file is not read every poll.
 */
async function addFile(walk: Walk, path: readonly string[]): Promise<void> {
  if (walk.files.size >= MAX_FILES) throw tooLarge(`more than ${MAX_FILES} files`);
  const key = path.join("/");
  if (key.length > MAX_MISE_PATH) throw tooLarge(`a path longer than ${MAX_MISE_PATH} characters`);
  let full = join(walk.root, ...path);
  if ((await lstat(full)).isSymbolicLink()) {
    full = await linkTarget(full, path);
    if (!isInside(walk.realRoot, full)) throw unchecked(path, "a symbolic link out of the worktree");
  }
  const info = await stat(full);
  if (info.isDirectory()) throw unchecked(path, "a linked directory");
  if (!info.isFile()) throw unchecked(path, "something other than a file");
  walk.bytes += info.size;
  if (walk.bytes > MAX_BYTES) throw tooLarge(`more than ${MAX_BYTES / 1024 / 1024} MB`);
  walk.files.set(key, await readFile(full));
}

/** The real path behind a link; a link to nothing or a loop of links is refused, not a daemon error. */
async function linkTarget(full: string, path: readonly string[]): Promise<string> {
  try {
    return await realpath(full);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ELOOP") throw unchecked(path, "a broken symbolic link");
    throw err;
  }
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

function unchecked(path: readonly string[], what: string): DomainError {
  return new DomainError(
    "mise_unavailable",
    `the mise config of the task worktree has ${what} (${path.join("/")}), which Trackwall does not check`,
  );
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
