import { readFile } from "node:fs/promises";

/** Linux's table of mounts for this process (`/proc/self/mountinfo`); `null` on Windows and macOS, which have none. */
export function mountTable(): Promise<string | null> {
  if (process.platform !== "linux") return Promise.resolve(null);
  return readFile("/proc/self/mountinfo", "utf8");
}
