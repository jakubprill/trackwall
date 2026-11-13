import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { gitDirs, readIfExists, statIfExists } from "./git-dir.ts";
import { pathKey } from "./path-key.ts";

/**
 * A repo's run settings (`CONTEXT.md`): what in its git directory makes git run a program, which a task session in
 * Copilot CLI's sandbox can still write, since the sandbox leaves the repo's `.git` writable for the task's commits.
 * A `filter.<driver>.clean` there runs on the daemon's next `git add` or `status`, outside the sandbox (ADR-181 addendum,
 * §8). The guard remembers the digest of the run settings each sandboxed task started with and refuses every daemon git
 * call in that repo once they differ from all of them, and every call in a task's worktree whose `.git` no longer
 * leads to the task's repo. It cannot close a race in which the agent swaps a file back and forth between the check
 * and git's own read; Copilot CLI's read-only paths do (§8).
 *
 * Read: the keys of the repo configuration `config` that make git run a program or read another file (`RUN_KEYS`),
 * without following includes, so the digest does not depend on the directory git runs in; `config.worktree` of the
 * repo and of each worktree; `info/attributes`; and the hook files in `hooks/`. Every daemon git call compares the
 * files' identity (`stat`, with the change time, which a program cannot set back) and reads them only when that changed.
 */

/**
 * Keys with which git runs a program, reads another configuration or works elsewhere. A relative `core.hooksPath`
 * without `..` (husky's `.husky`) is left out: it names a folder of the checkout git runs in, and the daemon's own
 * writing calls in a task's worktree run without hooks.
 */
const RUN_KEYS = [
  /^(filter|diff|difftool|mergetool|pager|alias|credential|include|includeif|url|uploadpack|extensions|gpg|ssh|man|browser|sequence|trailer|fsmonitor)\./,
  /^merge\.(tool|.+\.driver)$/s,
  /^core\.(fsmonitor|sshcommand|pager|editor|askpass|attributesfile|gitproxy|worktree|bare|alternaterefscommand)$/,
  /^remote\..+\.(vcs|uploadpack|receivepack|proxy)$/s,
  /^submodule\..+\.update$/s,
  /^web\.browser$/,
];

const HOOKS_PATH = "core.hookspath";

/** Reads `git config --file <file> --list -z --no-includes`: the caller runs git, so this file stays without a process. */
export type ReadConfigFile = (file: string) => Promise<string>;

/** A sandboxed task's worktree, its repo's root and the digest of the repo's run settings when the task started. */
export interface RunSettingsBaseline {
  worktree: string;
  repoDir: string;
  digest: string;
}

/** The digest of the run settings of the repo `dir` lies in; `null` when `dir` has no git directory. */
export async function runSettingsDigest(dir: string, readConfig: ReadConfigFile): Promise<string | null> {
  const dirs = await gitDirs(dir);
  if (dirs === null) return null;
  const common = dirs.commonDir;
  const configFile = join(common, "config");
  const [config, attributes, hooks, worktreeConfigs] = await Promise.all([
    (await statIfExists(configFile)) ? readConfig(configFile) : "",
    readIfExists(join(common, "info", "attributes")),
    hookContents(common),
    worktreeConfigContents(common),
  ]);
  const hash = createHash("sha256");
  for (const part of [...countedEntries(config), "\0attributes", attributes, "\0hooks", ...hooks, "\0worktrees", ...worktreeConfigs])
    hash.update(part).update("\0");
  return hash.digest("hex");
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
  if (same) return;
  baselines = next;
  matched.clear();
}

/**
 * Throws when `dir` is a sandboxed task's worktree whose `.git` leads elsewhere than its repo, or when `dir`'s repo has a
 * sandboxed task and its run settings match none of the baselines of its tasks. Returns whether the repo is guarded,
 * so that git leaves its submodules alone, whose own git directories the guard does not read.
 */
export async function assertRunSettings(dir: string, readConfig: ReadConfigFile): Promise<boolean> {
  if (baselines.length === 0) return false;
  // Resolved at every call: the agent can rewrite its worktree's `.git` file and `commondir`.
  const dirs = await gitDirs(dir).catch(() => null);
  const common = dirs === null ? null : await pathKey(dirs.commonDir);
  const dirKey = await pathKey(dir);
  const expected = new Set<string>();
  for (const b of baselines) {
    const repoCommon = await repoCommonDir(b.repoDir);
    if ((await pathKey(b.worktree)) === dirKey && (repoCommon === null || repoCommon !== common))
      throw new Error(`git in ${dir} is refused: the worktree's .git no longer leads to its repo's git directory`);
    if (repoCommon !== null && repoCommon === common) expected.add(b.digest);
  }
  if (common === null || expected.size === 0) return false;
  const stamp = await runSettingsStamp(common);
  if (matched.get(common) === stamp) return true;
  const digest = await runSettingsDigest(dir, readConfig);
  if (digest === null || !expected.has(digest))
    throw new Error(
      `git in ${dir} is refused: the repo's git settings that make git run a program (.git/config, .git/info/attributes or .git/hooks) changed since a task in the sandbox started; check them and undo the change`,
    );
  matched.set(common, stamp);
  return true;
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

/** The identities of every file `runSettingsDigest` reads, without reading them. */
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

async function hookContents(common: string): Promise<string[]> {
  const folder = join(common, "hooks");
  const names = await namesIn(folder);
  return Promise.all(names.map(async (name) => `${name}\n${await readHook(join(folder, name))}`));
}

/** A hook's bytes as hex; a folder named like a hook has none. */
async function readHook(path: string): Promise<string> {
  const info = await statIfExists(path);
  if (!info?.isFile()) return "-";
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function worktreeConfigContents(common: string): Promise<string[]> {
  const files = await worktreeConfigFiles(common);
  // Only those that exist: a new task's worktree must not change the digest the other tasks of the repo started with.
  const contents = await Promise.all(files.map(async (file) => [file.slice(common.length), await readIfExists(file)] as const));
  return contents.filter(([, content]) => content !== "").map(([file, content]) => `${file}\n${content}`);
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
