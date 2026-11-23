import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isInside } from "../../infra/path-inside.ts";
import { gitDirs, readIfExists, statIfExists } from "./git-dir.ts";
import { pathKey } from "./path-key.ts";
import {
  changedPlacesText,
  placesOf,
  type RunSettings,
  type RunSettingsFiles,
  type RunSettingsGuard,
  reviewRunSettings,
} from "./run-settings-places.ts";

/**
 * A repo's run settings (`CONTEXT.md`): what in its git directory makes git run a program, which a task session in
 * Copilot CLI's sandbox can still write, since the sandbox leaves the repo's `.git` writable for the task's commits.
 * A `filter.<driver>.clean` there runs on the daemon's next `git add` or `status`, outside the sandbox (ADR-181 addendum,
 * §8). The guard remembers the digest of the run settings each sandboxed task started with and refuses every daemon git
 * call in that repo once they differ from all of them, and every call in a task's worktree whose `.git` no longer
 * leads to the task's repo. It cannot close a race in which the agent swaps a file back and forth between the check
 * and git's own read; Copilot CLI's read-only paths do (§8).
 *
 * Hooks are not part of it for the daemon: its git runs none in such a repo (`git.ts`), since a hooks path may name a
 * folder of the worktree.
 *
 * Read: the keys of the repo configuration `config` that make git run a program or read another file (`RUN_KEYS`),
 * without following includes, so the digest does not depend on the directory git runs in; `config.worktree` of the
 * repo and of each worktree; `info/attributes`; and the hook files in `hooks/`. Every daemon git call compares the
 * files' identity (`stat`, with the change time, which a program cannot set back) and reads them only when that changed.
 */

/**
 * Keys with which git runs a program, reads another configuration, works elsewhere or sends its requests elsewhere:
 * `protocol.*` lets a remote's address name a program (`ext::`), `http.*` a proxy and whether its certificate is
 * checked, git-lfs runs the program of `lfs.customtransfer.*` at a checkout and those of `lfs.extension.*` on every LFS
 * file it reads or writes, and `gc` runs `gc.recentObjectsHook`. A relative `core.hooksPath` without
 * `..` (husky's `.husky`) is left out: a tool writes it in ordinary work, and it names a folder an agent writes anyway,
 * so the daemon's git runs no hooks at all in a repo with a task in the sandbox (`NO_HOOKS` in `no-hooks.ts`).
 */
const RUN_KEYS = [
  /^(filter|diff|difftool|mergetool|pager|alias|credential|include|includeif|url|uploadpack|extensions|gpg|ssh|man|browser|sequence|trailer|fsmonitor|protocol|http)\./,
  /^lfs\.(standalonetransferagent|customtransfer\..+|extension\..+)$/s,
  /^gc\.recentobjectshook$/,
  /^merge\.(tool|.+\.driver)$/s,
  /^core\.(fsmonitor|sshcommand|pager|editor|askpass|attributesfile|gitproxy|worktree|bare|alternaterefscommand)$/,
  /^remote\..+\.(vcs|uploadpack|receivepack|proxy)$/s,
  /^submodule\..+\.update$/s,
  /^web\.browser$/,
];

const HOOKS_PATH = "core.hookspath";

/** Reads `git config --file <file> --list -z --no-includes`: the caller runs git, so this file stays without a process. */
export type ReadConfigFile = (file: string) => Promise<string>;

/** A sandboxed task's worktree, its repo's root and the guard it keeps of the repo's run settings. */
export interface RunSettingsBaseline extends RunSettingsGuard {
  worktree: string;
  repoDir: string;
  /** The task's branch, which a refusal names, so the user knows whose guard it is. */
  branch: string;
}

/** At most this many changed places in a refusal's message. */
const MAX_NAMED_CHANGES = 5;

/** The run settings of the repo `dir` lies in; `null` when `dir` has no git directory. */
export async function readRunSettings(dir: string, readConfig: ReadConfigFile): Promise<RunSettings | null> {
  const dirs = await gitDirs(dir);
  if (dirs === null) return null;
  const common = dirs.commonDir;
  const configFile = join(common, "config");
  const [config, attributes, hooks, worktreeConfigs] = await Promise.all([
    (await statIfExists(configFile)) ? readConfig(configFile) : "",
    readIfExists(join(common, "info", "attributes")),
    hookFiles(common),
    worktreeConfigContents(common, readConfig),
  ]);
  const configEntries = countedEntries(config);
  // The digest's form stays as tasks saved it before places were named, so their digests still match.
  const hookParts = hooks.map(([name, content]) => `${name}\n${content === null ? "-" : sha256(content)}`);
  const parts = [...configEntries, "\0attributes", attributes, "\0hooks", ...hookParts, "\0worktrees"];
  for (const { file, content } of worktreeConfigs) parts.push(`${file}\n${content}`);
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return placesOf({ configEntries, attributes, hooks, worktreeConfigs }, hash.digest("hex"));
}

/**
 * Whether the user may accept the run settings `now`, reviewed as the version with `digest`: not once they changed
 * again, and not while a changed place is one only undoing clears (`run-settings-places.ts`). Returns the reason it may not.
 */
export function acceptanceRefusal(now: RunSettings, guards: readonly RunSettingsGuard[], digest: string): string | null {
  if (now.digest !== digest) return "they changed again; review them before accepting them";
  const undoOnly = reviewRunSettings(now, guards).changes.filter((c) => !c.acceptable);
  if (undoOnly.length > 0)
    return `${undoOnly.map((c) => c.place).join(", ")} can make git run a program Trackwall does not check; undo it in the repo instead`;
  return null;
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/** The entries of `git config -z --list` (`key\nvalue`, separated by NUL) that count, in their order. */
export function countedEntries(list: string): string[] {
  return list.split("\0").filter((entry) => {
    if (entry === "") return false;
    const newline = entry.indexOf("\n");
    const key = newline < 0 ? entry : entry.slice(0, newline);
    if (key === HOOKS_PATH) return !inCheckout(newline < 0 ? "" : entry.slice(newline + 1));
    return RUN_KEYS.some((runs) => runs.test(key));
  });
}

/** A relative path that stays in the checkout git runs in. */
function inCheckout(path: string): boolean {
  if (path === "" || /^([/\\~]|[A-Za-z]:)/.test(path)) return false;
  return !path.split(/[/\\]/).includes("..");
}

/**
 * The baselines of the listed sandboxed tasks. Process-wide, like the git program (`git-program.ts`), because `git()` is
 * a free function every part of `vcs` calls.
 */
let baselines: readonly RunSettingsBaseline[] = [];
/** A repo root's git common directory as a comparison key: its `.git` is a folder the sandbox cannot replace. */
const repoCommonDirs = new Map<string, Promise<string | null>>();
/** The file identities of a common directory's run settings when they last matched a baseline. */
const matched = new Map<string, string>();

/** The baselines of the sandboxed tasks now listed (the tasks module sets them at every save of its list). */
export function useRunSettingsBaselines(next: readonly RunSettingsBaseline[]): void {
  const same =
    next.length === baselines.length &&
    next.every((b, i) => b.worktree === baselines[i]?.worktree && b.repoDir === baselines[i]?.repoDir && b.digest === baselines[i]?.digest);
  // Kept whatever the digests: a baseline can get its snapshot (the places a refusal names) with the same digest.
  baselines = next;
  if (!same) matched.clear();
}

/**
 * Throws when `dir` is a sandboxed task's worktree, its repo's root or another worktree of that repo and its git
 * directory leads elsewhere than the repo's common directory (a rewritten `.git` file or `commondir`), or when `dir`'s repo has a
 * sandboxed task and its run settings match none of the baselines of its tasks. Returns whether the repo is guarded,
 * so that git leaves its submodules alone, whose own git directories the guard does not read.
 */
export async function assertRunSettings(dir: string, readConfig: ReadConfigFile): Promise<boolean> {
  if (baselines.length === 0) return false;
  // Resolved at every call: the agent can rewrite its worktree's `.git` file and `commondir`.
  const dirs = await gitDirs(dir).catch(() => null);
  const common = dirs === null ? null : await pathKey(dirs.commonDir);
  const dirKey = await pathKey(dir);
  const gitDir = dirs === null ? null : await pathKey(dirs.gitDir);
  const expected = new Set<string>();
  const known: RunSettingsBaseline[] = [];
  for (const b of baselines) {
    const repoCommon = await repoCommonDir(b.repoDir);
    if (repoCommon !== null && repoCommon === common) {
      expected.add(b.digest);
      known.push(b);
    } else if (await belongsTo(b, repoCommon, dirKey, gitDir))
      throw new Error(`git in ${dir} is refused: its .git no longer leads to its repo's git directory`);
  }
  if (common === null || expected.size === 0) return false;
  const stamp = await runSettingsStamp(common);
  if (matched.get(common) === stamp) return true;
  const now = await readRunSettings(dir, readConfig);
  if (now === null || !expected.has(now.digest)) throw new Error(refusal(dir, now, known));
  matched.set(common, stamp);
  return true;
}

/**
 * The refusal of git in `dir`: what changed against the guard closest to `now`, the tasks whose guards these are, the
 * two ways out, and how to keep a package install in a task from writing the shared hooks again.
 */
function refusal(dir: string, now: RunSettings | null, known: readonly RunSettingsBaseline[]): string {
  const what = changedPlacesText(now, known, MAX_NAMED_CHANGES);
  const tasks = [...new Set(known.map((b) => b.branch))].join(", ");
  return [
    `git in ${dir} is refused: the repo's git settings that make git run a program changed since a task in the sandbox started (${what}).`,
    `Tasks in the sandbox in this repo: ${tasks}.`,
    "Undo the change, or, for a hook or .git/info/attributes, read it and accept it in Trackwall under End task of one of those tasks.",
    "A package install in a task (lefthook, simple-git-hooks) writes the hooks every worktree shares; to prevent it, add the repo's .git/hooks and .git/config to readonlyPaths in the sandbox settings of Copilot CLI.",
  ].join(" ");
}

/**
 * Whether the directory `dirKey` is the task's worktree, its repo's root or another worktree of the repo (its git
 * directory `gitDir` lies in the repo's common directory), whose `commondir` the agent can write too.
 */
async function belongsTo(b: RunSettingsBaseline, repoCommon: string | null, dirKey: string, gitDir: string | null): Promise<boolean> {
  if (dirKey === (await pathKey(b.worktree))) return true;
  if (repoCommon === null) return false;
  return dirKey === (await pathKey(b.repoDir)) || (gitDir !== null && isInside(repoCommon, gitDir));
}

function repoCommonDir(repoDir: string): Promise<string | null> {
  const known = repoCommonDirs.get(repoDir);
  if (known) return known;
  const common = gitDirs(repoDir).then(
    (dirs) => (dirs === null ? null : pathKey(dirs.commonDir)),
    () => null,
  );
  repoCommonDirs.set(repoDir, common);
  void common.then((found) => {
    if (found === null && repoCommonDirs.get(repoDir) === common) repoCommonDirs.delete(repoDir);
  });
  return common;
}

/** A file's identity with its change time, which `utimes` cannot set back, unlike the modification time. */
function stampOf(info: Stats | undefined): string {
  return info ? `${info.mtimeMs}:${info.ctimeMs}:${info.size}:${info.ino}` : "-";
}

/** The identities of every file `readRunSettings` reads, without reading them. */
async function runSettingsStamp(common: string): Promise<string> {
  const [config, attributes, hooks, worktrees] = await Promise.all([
    statIfExists(join(common, "config")),
    statIfExists(join(common, "info", "attributes")),
    folderStamp(join(common, "hooks")),
    worktreeConfigFiles(common).then((files) => Promise.all(files.map(async (file) => stampOf(await statIfExists(file))))),
  ]);
  return [stampOf(config), stampOf(attributes), hooks, ...worktrees].join("|");
}

async function folderStamp(folder: string): Promise<string> {
  const names = await namesIn(folder);
  const keys = await Promise.all(names.map(async (name) => `${name}=${stampOf(await statIfExists(join(folder, name)))}`));
  return keys.join(",");
}

/** Each hook file's name and bytes, sorted by name; a folder named like a hook has none. */
async function hookFiles(common: string): Promise<[string, Buffer | null][]> {
  const folder = join(common, "hooks");
  const names = await namesIn(folder);
  return Promise.all(
    names.map(async (name): Promise<[string, Buffer | null]> => {
      const path = join(folder, name);
      const info = await statIfExists(path);
      return [name, info?.isFile() ? await readFile(path) : null];
    }),
  );
}

/** Each existing `config.worktree` with its path from the common directory (starting with a separator), its text and entries. */
async function worktreeConfigContents(common: string, readConfig: ReadConfigFile): Promise<RunSettingsFiles["worktreeConfigs"]> {
  const files = await worktreeConfigFiles(common);
  // Only those that exist: a new task's worktree must not change the digest the other tasks of the repo started with.
  const read = await Promise.all(
    files.map(async (path) => {
      const content = await readIfExists(path);
      const entries = content === "" ? [] : (await readConfig(path)).split("\0").filter((entry) => entry !== "");
      return { file: path.slice(common.length), content, entries, counted: countedEntries(entries.join("\0")) };
    }),
  );
  return read.filter(({ content }) => content !== "");
}

/** `config.worktree` of the repo and of each of its worktrees (`worktrees/<name>/`), whether or not it exists. */
async function worktreeConfigFiles(common: string): Promise<string[]> {
  const worktrees = await namesIn(join(common, "worktrees"));
  return [join(common, "config.worktree"), ...worktrees.map((name) => join(common, "worktrees", name, "config.worktree"))];
}

/** The names in `folder`, sorted; none for a folder that is not there. */
async function namesIn(folder: string): Promise<string[]> {
  try {
    return (await readdir(folder)).sort();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw err;
  }
}
