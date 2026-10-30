import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LogSource } from "@trackwall/protocol";

/**
 * The JSONL file of one source (§4.2): `logs/<kind>/<repo>/<mise task>.jsonl` in the state directory, one line per
 * record. Writes are buffered and appended in batches (`flush`), so that a noisy process does not write on every line.
 * After the limit the file becomes `<name>.1.jsonl` (the previous `.1` disappears), so a source takes at most
 * two limits. A failed write (e.g. a file held by an antivirus) stays in the buffer until the next attempt.
 */

/** At most this much unwritten text waits in memory when writes fail; the excess is dropped with an entry in the log. */
const MAX_PENDING_CHARS = 4 * 1024 * 1024;

export class LogFile {
  readonly path: string;
  private readonly maxBytes: number;
  private readonly onRotationError: (err: unknown) => void;
  /** A failed rotation is reported once, until the next successful one. */
  private rotationFailing = false;
  private pending: string[] = [];
  private pendingChars = 0;
  /** The size of the file on disk; unknown until the first write (the file may be left from a previous daemon run). */
  private size: number | undefined;

  constructor(path: string, maxBytes: number, onRotationError: (err: unknown) => void) {
    this.path = path;
    this.maxBytes = maxBytes;
    this.onRotationError = onRotationError;
  }

  /** Returns `false` when the buffer is full and the line was dropped. */
  append(json: string): boolean {
    if (this.pendingChars + json.length > MAX_PENDING_CHARS) return false;
    this.pending.push(`${json}\n`);
    this.pendingChars += json.length + 1;
    return true;
  }

  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  /** Appends the buffer to the file; throws a file system error, and the buffer stays for the next attempt. */
  flush(): void {
    if (this.pending.length === 0) return;
    const text = this.pending.join("");
    const bytes = Buffer.byteLength(text);
    mkdirSync(dirname(this.path), { recursive: true });
    this.size ??= sizeOf(this.path);
    if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
    appendFileSync(this.path, text);
    this.size += bytes;
    this.pending = [];
    this.pendingChars = 0;
  }

  /**
   * A rotation that failed (on Windows a file opened without `FILE_SHARE_DELETE`, e.g. by `Get-Content -Wait`
   * or an antivirus) does not hold up writing: the file grows past the limit, and the rotation is retried on the next write.
   */
  private rotate(): void {
    try {
      renameSync(this.path, rotatedPath(this.path));
      this.size = 0;
      this.rotationFailing = false;
    } catch (err) {
      if (!this.rotationFailing) this.onRotationError(err);
      this.rotationFailing = true;
    }
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
}

export function rotatedPath(path: string): string {
  return path.replace(/\.jsonl$/, ".1.jsonl");
}

/** The path of a source's file in the logs directory. */
export function logFilePath(dir: string, source: LogSource): string {
  const [kind, ...names] = sourceParts(source);
  const encoded = names.map(fileName);
  return `${join(dir, kind, ...encoded)}.jsonl`;
}

/** The directory of every log of a task's worktree (`logs/task-mise-task/<task>`), removed with the task (ADR-59). */
export function taskLogDir(dir: string, task: string): string {
  return join(dir, TASK_LOG_KIND, fileName(task));
}

/** The directory of the logs of task worktrees, one subdirectory per task. */
export function taskLogsRoot(dir: string): string {
  return join(dir, TASK_LOG_KIND);
}

const TASK_LOG_KIND = "task-mise-task" satisfies LogSource["kind"];

/** The kind and names of a source, from general to specific: the log directories and file, and the source key in memory. */
export function sourceParts(source: LogSource): [string, ...string[]] {
  switch (source.kind) {
    case "mise-task":
      return [source.kind, source.repo, source.miseTask];
    // Without the repo: the task id names it, and a shorter path keeps the file under 260 characters on Windows.
    case "task-mise-task":
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
