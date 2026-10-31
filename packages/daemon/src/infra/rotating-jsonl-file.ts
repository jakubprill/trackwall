import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

/**
 * A JSONL file appended to with one rotation: the file of one log source (§4.2) and the MCP audit (§4.19). Writes are
 * buffered and appended in batches (`flush`), so that a noisy process does not write on every line. After the limit
 * the file becomes `<name>.1.jsonl` (the previous `.1` disappears), so it takes at most two limits. A failed write
 * (e.g. a file held by an antivirus) stays in the buffer until the next attempt.
 */

/** At most this much unwritten text waits in memory when writes fail; the excess is dropped with an entry in the log. */
const MAX_PENDING_CHARS = 4 * 1024 * 1024;

export class RotatingJsonlFile {
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
