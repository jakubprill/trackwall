import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * A git directory of the daemon's that reads another repo's objects through `objects/info/alternates` and writes new
 * ones into its own: the store's push repo (ADR-127) and the trial merge (ADR-230), so that neither runs with config an
 * agent can write, nor writes into the repo it reads.
 */

/** Points the objects of the git directory `gitDir` at `objects` as well. */
export async function borrowObjects(gitDir: string, objects: string): Promise<void> {
  await mkdir(join(gitDir, "objects", "info"), { recursive: true });
  // Forward slashes, which git reads on every system.
  await writeFile(join(gitDir, "objects", "info", "alternates"), `${objects.replaceAll("\\", "/")}\n`);
}

/**
 * An empty bare git directory in `dir` (an existing empty folder) that borrows `objects` in the object format `objectFormat`.
 * Written by hand, without `git init`, which would cost a process on every call and copy the user's template hooks.
 */
export async function borrowingGitDir(dir: string, objects: string, objectFormat: string): Promise<void> {
  await borrowObjects(dir, objects);
  await mkdir(join(dir, "refs"));
  await writeFile(join(dir, "HEAD"), "ref: refs/heads/main\n");
  const format = objectFormat === "sha1" ? "" : `[extensions]\n\tobjectformat = ${objectFormat}\n`;
  await writeFile(join(dir, "config"), `[core]\n\trepositoryformatversion = ${format ? 1 : 0}\n\tbare = true\n${format}`);
}
