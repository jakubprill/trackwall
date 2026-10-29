import { rmSync } from "node:fs";

/**
 * Removes a folder with everything in it, as a user or a test cleanup would. On Windows a file in it can stay held for a
 * moment after the process that used it has exited (a compiled binary that just ran, git, an antivirus scan), and
 * `rmSync` then fails with EBUSY, EPERM or ENOTEMPTY, so the removal is retried with a growing wait. Not with `rmSync`'s
 * own `maxRetries`: Bun ignores it (Node retries). Without `force`, so a test that removes a wrong path fails.
 */

const REMOVE_ATTEMPTS = 10;
const REMOVE_BACKOFF_MS = 50;
const RETRYABLE = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

export function removeFolder(path: string, remove: (path: string) => void = removeRecursively): void {
  for (let attempt = 1; ; attempt++) {
    try {
      remove(path);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (!RETRYABLE.has(code) || attempt >= REMOVE_ATTEMPTS) throw err;
      // A synchronous wait, so that the helper fits the synchronous cleanups and actions of the tests.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, REMOVE_BACKOFF_MS * attempt);
    }
  }
}

function removeRecursively(path: string): void {
  rmSync(path, { recursive: true });
}
