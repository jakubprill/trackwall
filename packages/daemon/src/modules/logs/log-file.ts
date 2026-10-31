import { createHash } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { LogSource } from "@trackwall/protocol";

/**
 * Where a source's JSONL file is (§4.2): `logs/<kind>/<repo>/<mise task>.jsonl` in the state directory, and the folders
 * of a task's logs. The file itself is a `RotatingJsonlFile`.
 */

/** The path of a source's file in the logs directory. */
export function logFilePath(dir: string, source: LogSource): string {
  const [kind, ...names] = sourceParts(source);
  const encoded = names.map(fileName);
  return `${join(dir, kind, ...encoded)}.jsonl`;
}

/** The kind of the sources of a task's worktree, whose logs go with the task (ADR-59). */
export const TASK_LOG_KIND = "task-mise-task" satisfies LogSource["kind"];

/** The directory of the logs of task worktrees, one subdirectory per task. */
function taskLogsRoot(dir: string): string {
  return join(dir, TASK_LOG_KIND);
}

/** The directory of every log of a task's worktree (`logs/task-mise-task/<task>`), as `sourceParts` lays it out. */
export function taskLogDir(dir: string, task: string): string {
  return join(taskLogsRoot(dir), fileName(task));
}

/** Removes a log directory with its files; a few retries get past a short lock (an antivirus scan on Windows). */
export function removeLogDir(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 3 });
}

/** The task log directories on disk other than those of `tasks`; none when there is no such directory yet. */
export function otherTaskLogDirs(dir: string, tasks: readonly string[]): string[] {
  const root = taskLogsRoot(dir);
  const kept = new Set(tasks.map(fileName));
  let names: string[];
  try {
    names = readdirSync(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return names.filter((name) => !kept.has(name)).map((name) => join(root, name));
}

/** The kind and names of a source, from general to specific: the log directories and file, and the source key in memory. */
export function sourceParts(source: LogSource): [string, ...string[]] {
  switch (source.kind) {
    case "mise-task":
      return [source.kind, source.repo, source.miseTask];
    // Without the repo: the task id names it, and a shorter path keeps the file under 260 characters on Windows.
    case TASK_LOG_KIND:
      return [source.kind, source.task, source.miseTask];
    case "mise-install":
      return [source.kind, source.repo];
  }
}

/**
 * Windows device names; with an extension too (`con.jsonl` is a device), but after encoding the name has no dot,
 * so comparing the whole name is enough.
 */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
/**
 * A longer name is shortened with a hash: two such names with `logs\mise-task` and `.1.jsonl` are about 140 characters, so
 * the path fits in Windows' 260-character limit with a state directory of up to about 100 characters.
 */
const MAX_NAME_CHARS = 60;

/**
 * A file name from any string, the same on Windows and macOS: characters outside `[a-z0-9_-]` (including `:` from `build:ui`,
 * `.` and upper case, because the macOS and Windows file systems do not tell `Build` from `build`) as `%XX` UTF-8 bytes,
 * and a reserved name starts with `%`. Different strings give different names.
 */
export function fileName(name: string): string {
  let encoded = [...Buffer.from(name, "utf8")]
    .map((b) => (/[a-z0-9_-]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, "0")}`))
    .join("");
  if (RESERVED.test(encoded)) encoded = `%${encoded}`;
  if (encoded.length <= MAX_NAME_CHARS) return encoded;
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 12);
  return `${encoded.slice(0, MAX_NAME_CHARS - hash.length - 1)}~${hash}`;
}
