import { mkdir, rename, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { REMOVED_REPOS_DIR } from "@trackwall/protocol";
import { DomainError } from "../../infra/errors.ts";

/**
 * Removing a repo from the projects folder (ADR-83): its folder moves into `REMOVED_REPOS_DIR` in the projects folder,
 * which the repo list skips like every hidden folder. A move on the same drive is one rename, keeps files outside git
 * (`.env`, local settings, unpushed branches) and can be undone by hand; deleting is left to the user. The caller
 * makes sure nothing of Trackwall runs in the repo; a file another program holds open fails the rename on Windows.
 */

/** Errors of a rename that some program still holds a file or the folder open (Windows), worth a clear message. */
const HELD_OPEN = new Set(["EPERM", "EBUSY", "EACCES"]);

export async function moveRepoOut(projectsDir: string, repoDir: string): Promise<string> {
  const removedDir = join(projectsDir, REMOVED_REPOS_DIR);
  await mkdir(removedDir, { recursive: true });
  const target = await freeName(removedDir, basename(repoDir));
  try {
    await rename(repoDir, target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    if (!HELD_OPEN.has(code)) throw err;
    throw new DomainError(
      "bad_request",
      `${repoDir} could not be moved (${code}): a program holds a file in it open, such as an editor, a terminal or a build; close it and approve again`,
    );
  }
  return target;
}

/** The repo's name, or with a numbered suffix when a repo of that name was removed before. */
async function freeName(dir: string, name: string): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = join(dir, n === 1 ? name : `${name}-${n}`);
    if (!(await exists(candidate))) return candidate;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
