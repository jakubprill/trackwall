import { randomBytes } from "node:crypto";
import { chmodSync, renameSync, rmSync, writeFileSync } from "node:fs";

/**
 * Writes a file through a temporary file and `rename`: a reader sees the old or the new content, never a cut one.
 * On Windows `rename` onto a file briefly opened by an antivirus, an indexer or an editor ends in EPERM/EBUSY,
 * so it is retried; after a failure the temporary file is cleaned up. The temporary file has a random name and must not
 * exist yet (`wx`), so a link planted under a name it could have, in a folder an agent can write to (the board, §8),
 * is never written through.
 */

const RENAME_ATTEMPTS = 5;
const RENAME_BACKOFF_MS = 40;
const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"]);

/** `mode` sets permissions where the system has them (not on Windows). */
export function writeFileAtomic(target: string, text: string, mode?: number): void {
  const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, text, { flag: "wx", ...(mode === undefined ? {} : { mode }) });
    if (mode !== undefined && process.platform !== "win32") chmodSync(tmp, mode);
    renameWithRetry(tmp, target);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // A temporary file held by another process: it stays, and the caller gets the original write error.
    }
    throw err;
  }
}

function renameWithRetry(from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (process.platform !== "win32" || !RETRYABLE.has(code) || attempt >= RENAME_ATTEMPTS) throw err;
      // A short synchronous wait: writes are rare, and the callers are not asynchronous.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_BACKOFF_MS * attempt);
    }
  }
}
