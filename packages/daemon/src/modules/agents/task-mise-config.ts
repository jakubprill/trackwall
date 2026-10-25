import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import type { MiseConfigChange } from "@trackwall/protocol";
import { DomainError } from "../../infra/errors.ts";

/**
 * The mise config of a task worktree (§4.4, ADR-59): the files mise reads for the tasks and the environment of a run in
 * the worktree root, each with a hash of its content. These are the config files (also the local ones git ignores,
 * such as `mise.local.toml`, which the task changes do not show), `.tool-versions` and the file tasks. A task stores the
 * snapshot the user trusted, and mise tasks run in its worktree only while the current snapshot is the same. Files a
 * config names elsewhere (`task_config.includes`, `[env] _.source`, `_.file`) are not in it, like the build scripts a
 * task runs (§8).
 */

/** Path relative to the worktree root, with `/`, mapped to the SHA-256 of the file's content. */
export type MiseSnapshot = Record<string, string>;

/** A mise config file name: `mise.toml`, `.mise.toml`, `mise.local.toml`, `mise.dev.toml`, `.mise.dev.local.toml`… */
const CONFIG_NAME = /^\.?mise(\.[^/\\]+)?\.toml$/;
/** Read in the worktree root besides the config files. */
const ROOT_FILES = [".tool-versions"];
/** Directories mise reads whole: `config.toml`, `conf.d/` and file tasks, or file tasks only (`mise-tasks`). */
const MISE_DIRS: readonly (readonly string[])[] = [["mise"], [".mise"], [".config", "mise"], ["mise-tasks"], [".mise-tasks"]];
/** A mise config is a few small files; more means a generated directory, and reading it every few seconds would be costly. */
const MAX_FILES = 500;
const MAX_BYTES = 8 * 1024 * 1024;

interface Walk {
  readonly root: string;
  readonly files: Map<string, string>;
  bytes: number;
}

export async function readMiseConfig(worktree: string): Promise<MiseSnapshot> {
  const walk: Walk = { root: worktree, files: new Map(), bytes: 0 };
  await addMatching(walk, [], (name) => CONFIG_NAME.test(name) || ROOT_FILES.includes(name));
  await addMatching(walk, [".config"], (name) => CONFIG_NAME.test(name));
  for (const dir of MISE_DIRS) await addTree(walk, dir);
  return Object.fromEntries([...walk.files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** What differs in `current` from `trusted`, sorted by path. */
export function miseConfigChanges(trusted: MiseSnapshot, current: MiseSnapshot): MiseConfigChange[] {
  const paths = [...new Set([...Object.keys(trusted), ...Object.keys(current)])].sort();
  return paths.flatMap((path): MiseConfigChange[] => {
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

async function addTree(walk: Walk, dir: readonly string[]): Promise<void> {
  for (const entry of await entries(join(walk.root, ...dir))) {
    const path = [...dir, entry.name];
    await (entry.isDirectory() ? addTree(walk, path) : addFile(walk, path));
  }
}

/** A symbolic link counts by its target, without following it: a link out of the worktree must not be read. */
async function addFile(walk: Walk, path: readonly string[]): Promise<void> {
  if (walk.files.size >= MAX_FILES) throw tooLarge(`more than ${MAX_FILES} files`);
  const full = join(walk.root, ...path);
  const content = (await lstat(full)).isSymbolicLink() ? Buffer.from(`symlink:${await readlink(full)}`) : await readFile(full);
  walk.bytes += content.length;
  if (walk.bytes > MAX_BYTES) throw tooLarge(`more than ${MAX_BYTES / 1024 / 1024} MB`);
  walk.files.set(path.join("/"), sha256(content));
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

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
