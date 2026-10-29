import { rm } from "node:fs/promises";

/**
 * Removes a folder with everything in it; a folder that is not there is an error, so a wrong path does not pass
 * unnoticed. On Windows a file in it can
 * stay held for a moment after the process that used it has exited (git, a build, a binary that just ran, an antivirus
 * scan), and the removal fails with EBUSY, EPERM or ENOTEMPTY, so it is retried with a growing wait. The retry is our
 * own, not `rm`'s `maxRetries`: Bun, which runs the daemon binary, ignores that option (Node honours it).
 */

const REMOVE_ATTEMPTS = 10;
const REMOVE_BACKOFF_MS = 50;
const RETRYABLE = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

export async function removeFolder(path: string, remove: (path: string) => Promise<void> = removeRecursively): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await remove(path);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (!RETRYABLE.has(code) || attempt >= REMOVE_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, REMOVE_BACKOFF_MS * attempt));
    }
  }
}

function removeRecursively(path: string): Promise<void> {
  return rm(path, { recursive: true });
}
