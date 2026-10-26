import type { Stats } from "node:fs";
import { lstat, readFile } from "node:fs/promises";

/**
 * Reading one local config file (§4.13): only a regular file counts, never a link, which could point at any file on the
 * user's disk, and a file over the limit is refused rather than copied in part.
 */

/** A local config file is a few lines; a bigger one is not what the user meant to back up. */
const MAX_LOCAL_CONFIG_BYTES = 1024 * 1024;

/** `undefined` for a path with nothing at it. */
export async function lstatIfExists(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** The content of the regular file at `path`; `undefined` when there is none, and an error for a link or a file over the limit. */
export async function readLocalConfigFile(path: string): Promise<Buffer | undefined> {
  const info = await lstatIfExists(path);
  if (!info) return undefined;
  if (!info.isFile()) throw new Error(`${path} is not a regular file (a link or a folder)`);
  if (info.size > MAX_LOCAL_CONFIG_BYTES) throw new Error(`${path} is larger than ${MAX_LOCAL_CONFIG_BYTES / 1024} KB`);
  return readFile(path);
}
