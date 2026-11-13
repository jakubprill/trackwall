import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { gitDirs, optionalKey, readIfExists, statIfExists } from "./git-dir.ts";
import { pathKey } from "./path-key.ts";

/**
 * A repo's run settings (`CONTEXT.md`): what in its git directory makes git run a program, which a task session in
 * Copilot CLI's sandbox can still write, since the sandbox leaves the repo's `.git` writable for the task's commits.
 * A `filter.<driver>.clean` there runs on the daemon's next `git add` or `status`, outside the sandbox (ADR-181 addendum,
 * §8). The guard remembers the digest of the run settings each sandboxed task started with and refuses every daemon git
 * call in that repo once they differ from all of them: the agent cannot change them back unseen, and the user's own
 * change while such a task lives is refused the same way, until the user undoes it or ends the task.
 *
 * Read: the repo configuration `config` and its includes (`git config --file`, never a program), except the keys git
 * writes in ordinary work (`HARMLESS_KEYS`); `config.worktree` of the repo and of each worktree; `info/attributes`; and
 * the hook files in `hooks/`. Every daemon git call checks the files' identity (`stat`), and reads them only when that changed.
 */

/** Keys that `push -u`, `remote add`, `branch` or `git maintenance` write, none of which makes git run a program. */
const HARMLESS_KEYS = [
  /^branch\..+\.(remote|merge|rebase|pushremote|description)$/s,
  /^remote\..+\.(url|pushurl|fetch|push|tagopt|prune|prunetags|mirror|skipdefaultupdate|skipfetchall|promisor|partialclonefilter)$/s,
  /^user\.(name|email)$/,
  /^maintenance\.(auto|strategy|repo)$/,
  /^maintenance\.[^.]+\.(enabled|schedule)$/,
];

/** Reads `git config --file <file> --list -z --includes`: the caller runs git, so this file stays without a process. */
export type ReadConfigFile = (file: string) => Promise<string>;

/** A sandboxed task's worktree and the digest of its repo's run settings when the task started. */
export interface RunSettingsBaseline {
  worktree: string;
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
    return !HARMLESS_KEYS.some((harmless) => harmless.test(key));
  });
}

/**
 * Per git common directory: whether its run settings still match a baseline. Process-wide, like the git program
 * (`git-program.ts`), because `git()` is a free function every part of `vcs` calls.
 */
let baselines: readonly RunSettingsBaseline[] = [];
/** A directory's git common directory as a comparison key; `null` without one. A directory never changes its repo. */
const commonDirs = new Map<string, Promise<string | null>>();
/** The file identities of a common directory's run settings when they last matched a baseline. */
const matched = new Map<string, string>();

/** The baselines of the sandboxed tasks now listed (the tasks module sets them at every save of its list). */
export function useRunSettingsBaselines(next: readonly RunSettingsBaseline[]): void {
  const same =
    next.length === baselines.length && next.every((b, i) => b.worktree === baselines[i]?.worktree && b.digest === baselines[i]?.digest);
  if (same) return;
  baselines = next;
  matched.clear();
}

/** Throws when `dir`'s repo has a sandboxed task and its run settings match none of the baselines of its tasks. */
export async function assertRunSettings(dir: string, readConfig: ReadConfigFile): Promise<void> {
  if (baselines.length === 0) return;
  const common = await commonDirOf(dir);
  if (common === null) return;
  const owned = await Promise.all(baselines.map(async (b) => ((await commonDirOf(b.worktree)) === common ? b.digest : null)));
  const expected = new Set(owned.filter((digest) => digest !== null));
  if (expected.size === 0) return;
  const stamp = await runSettingsStamp(common);
  if (matched.get(common) === stamp) return;
  const digest = await runSettingsDigest(dir, readConfig);
  if (digest === null || !expected.has(digest))
    throw new Error(
      `git in ${dir} is refused: the repo's git settings that make git run a program (.git/config, .git/info/attributes or .git/hooks) changed since a task in the sandbox started; check them, then undo the change or end the task`,
    );
  matched.set(common, stamp);
}

function commonDirOf(dir: string): Promise<string | null> {
  const known = commonDirs.get(dir);
  if (known) return known;
  const common = gitDirs(dir).then(
    (dirs) => (dirs === null ? null : pathKey(dirs.commonDir)),
    () => null,
  );
  commonDirs.set(dir, common);
  // A directory that is not a repo yet (a worktree being made) is asked again next time.
  void common.then((found) => {
    if (found === null && commonDirs.get(dir) === common) commonDirs.delete(dir);
  });
  return common;
}

/** The identities of every file `runSettingsDigest` reads, without reading them. */
async function runSettingsStamp(common: string): Promise<string> {
  const [config, attributes, hooks, worktrees] = await Promise.all([
    statIfExists(join(common, "config")),
    statIfExists(join(common, "info", "attributes")),
    folderStamp(join(common, "hooks")),
    worktreeConfigFiles(common).then((files) => Promise.all(files.map(async (file) => optionalKey(await statIfExists(file))))),
  ]);
  return [optionalKey(config), optionalKey(attributes), hooks, ...worktrees].join("|");
}

async function folderStamp(folder: string): Promise<string> {
  const names = await namesIn(folder);
  const keys = await Promise.all(names.map(async (name) => `${name}=${optionalKey(await statIfExists(join(folder, name)))}`));
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
