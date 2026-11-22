import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The files in the workspace store's folder (§4.13): copies of its last commit for the user to browse, which the commit
 * already holds. An agent can write into the folder, so every folder on the way must be a real one, never a link planted
 * to send a write elsewhere.
 */

/** Writes the copy of `path` (with `/`) to a new file renamed over the old one. */
export async function writeStoreCopy(store: string, path: string, content: Buffer): Promise<void> {
  const parts = path.split("/");
  const file = parts.pop() ?? "";
  const folder = await realFolder(store, parts, true);
  const temp = join(folder, `.${file}.${randomUUID()}.tmp`);
  await writeFile(temp, content, { flag: "wx" });
  // On Windows a rename fails while an editor holds the old file open; the next backup of the file writes it again.
  await rename(temp, join(folder, file)).catch(async (err: unknown) => {
    await rm(temp, { force: true });
    throw err;
  });
}

/** Removes the copy of `path` when it is a file, then its folder once empty; nothing there is fine. */
export async function removeStoreCopy(store: string, path: string): Promise<void> {
  const parts = path.split("/");
  const file = parts.pop() ?? "";
  const folder = await realFolder(store, parts, false).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return undefined;
    throw err;
  });
  if (folder === undefined) return;
  const target = join(folder, file);
  if ((await lstat(target).catch(() => undefined))?.isFile()) await rm(target);
  // A folder the user or another file still uses stays.
  await rmdir(folder).catch(() => undefined);
}

/** The folder `parts` below `store`, each level checked to be a real folder; made on the way when `make`. */
async function realFolder(store: string, parts: readonly string[], make: boolean): Promise<string> {
  let folder = store;
  for (const part of parts) {
    folder = join(folder, part);
    if (make) await mkdir(folder).catch((err: NodeJS.ErrnoException) => (err.code === "EEXIST" ? undefined : Promise.reject(err)));
    if (!(await lstat(folder)).isDirectory()) throw new Error(`${folder} in the workspace store is not a folder`);
  }
  return folder;
}
