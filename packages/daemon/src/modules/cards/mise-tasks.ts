import type { CardProblem, DeclaredMiseTask, MiseSetup } from "@trackwall/protocol";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { messageOf } from "../../infra/errors.ts";
import { baseName, dirOf } from "./repo-path.ts";
import { keyLines, type RepoSnapshot } from "./snapshot.ts";
import { MISE_CONFIG_FILES, TOML_KEY } from "./tools.ts";

/**
 * The repo's mise configuration from the commit tree (§4.6, ADR-34): which mise config files are in the repo and which
 * mise tasks are defined in their `[tasks]` and in file mise task directories. No `mise tasks ls`, for the same reasons as the
 * tools in `tools.ts` (ADR-25): the commit instead of the working directory, and no mise trust. A config file is parsed
 * here a second time (the first for `[tools]`), because it is a few small files per commit, and a card is computed once.
 */

/** Config files from the root (those from `tools.ts` and `.config/mise/mise.toml`) and `conf.d` directories with any `*.toml`. */
const ROOT_CONFIG_FILES = [...MISE_CONFIG_FILES, ".config/mise/mise.toml"];
const CONF_D_DIRS = ["mise/conf.d", ".mise/conf.d", ".config/mise/conf.d"];
/** File mise task directories mise reads by default in the repo root. */
const FILE_TASK_DIRS = ["mise-tasks", ".mise-tasks", "mise/tasks", ".mise/tasks", ".config/mise/tasks"];
/** A mise task's table header (`[tasks.build]`, `[tasks."test:unit"]`); classes without spaces, so no backtracking on a long line. */
const TASK_HEADER = /^\s*\[tasks\.(?:"([^"]*)"|'([^']*)'|([^"'\s\]]+))\s*\]/g;
const TASKS_TABLE = /^\s*\[tasks\]\s*$/;
const ANY_TABLE = /^\s*\[/;
/** Only the `[tasks]` keys; a bad entry in another table is a matter for `tools.ts`. */
const MiseTasksConfig = z.object({ tasks: z.record(z.string(), z.unknown()).catch({}) });

export function isMiseConfigFile(path: string): boolean {
  return ROOT_CONFIG_FILES.includes(path) || (CONF_D_DIRS.includes(dirOf(path)) && path.endsWith(".toml"));
}

/**
 * Config files in the order of `ROOT_CONFIG_FILES`, then `conf.d`, so the reason for the `no-mise` tag points to
 * `mise.toml`, not a random file from git's list. The result is incomplete (`complete: false`) when some file was not read
 * or the commit's file list is truncated (a read problem without a path): then it is unknown whether the repo has mise tasks.
 */
export function extractMiseSetup(snapshot: RepoSnapshot): { mise: MiseSetup; problems: CardProblem[] } {
  const configFiles = snapshot.paths.filter(isMiseConfigFile).sort((a, b) => configRank(a) - configRank(b));
  const problems: CardProblem[] = [];
  const read = configFiles.flatMap((path) => {
    const text = snapshot.text(path);
    return text === undefined ? [] : [{ path, text }];
  });
  const tasks = [...read.flatMap((f) => tomlTasks(f.path, f.text, problems)), ...fileTasks(snapshot.paths)];
  const complete = read.length === configFiles.length && !snapshot.problems.some((p) => p.path === "");
  return { mise: { configFiles, tasks, complete }, problems };
}

function configRank(path: string): number {
  const rank = ROOT_CONFIG_FILES.indexOf(path);
  return rank < 0 ? ROOT_CONFIG_FILES.length : rank;
}

/**
 * The `[tasks]` keys; a file that is not valid TOML gives no mise tasks. A card problem is reported here only for files
 * `tools.ts` does not read, so that the same bad file is not on the card twice.
 */
function tomlTasks(path: string, text: string, problems: CardProblem[]): DeclaredMiseTask[] {
  let parsed: unknown;
  try {
    parsed = parseToml(text);
  } catch (err) {
    if (!MISE_CONFIG_FILES.includes(path)) problems.push({ path, message: messageOf(err) });
    return [];
  }
  const config = MiseTasksConfig.safeParse(parsed);
  if (!config.success) return [];
  const headers = keyLines(text, TASK_HEADER);
  const inTable = tasksTableLines(text);
  const dotted = keyLines(text, TOML_KEY);
  return Object.keys(config.data.tasks).map((name) => ({
    name,
    evidence: { path, line: headers.get(name) ?? inTable.get(name) ?? dotted.get(`tasks.${name}`) ?? null },
  }));
}

/** Lines of keys inside the `[tasks]` table (`build = "make"`), so that a key with the same name in `[tools]` is not evidence. */
function tasksTableLines(text: string): Map<string, number> {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => TASKS_TABLE.test(line));
  if (start < 0) return new Map();
  const end = lines.findIndex((line, i) => i > start && ANY_TABLE.test(line));
  const table = lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
  return new Map([...keyLines(table, TOML_KEY)].map(([name, line]) => [name, line + start + 1]));
}

/**
 * Files in mise task directories; hidden files (`.gitkeep`) are not mise tasks, and `_default` is the mise task named
 * after its directory.
 */
function fileTasks(paths: readonly string[]): DeclaredMiseTask[] {
  return FILE_TASK_DIRS.flatMap((dir) =>
    paths
      .filter((path) => path.startsWith(`${dir}/`) && !baseName(path).startsWith("."))
      .map((path) => ({ name: taskName(path.slice(dir.length + 1)), evidence: { path, line: null } })),
  );
}

function taskName(relative: string): string {
  const parts = relative.split("/");
  if (parts.at(-1) === "_default" && parts.length > 1) parts.pop();
  return parts.join(":");
}
