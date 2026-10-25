import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * A path as a comparison key: after resolving links (`/var` and `/private/var` on macOS), case-insensitive where
 * drives do not distinguish case by default (Windows, macOS). A path that does not exist is compared after `resolve`.
 */
export async function pathKey(path: string): Promise<string> {
  const real = await realpath(path).catch(() => resolve(path));
  return process.platform === "linux" ? real : real.toLowerCase();
}
