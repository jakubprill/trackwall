import { mkdir, rename, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { DomainError } from "../../infra/errors.ts";
import { ensureTrackwallDir, trackwallDir } from "../../infra/trackwall-dir.ts";

/**
 * Removing a repo from the projects folder (ADR-83): its folder moves into `.trackwall/removed` (ADR-125),
 * which the repo list skips like every hidden folder. A move on the same drive is one rename, keeps files outside git
 * (`.env`, local settings, unpushed branches) and can be undone by hand; deleting is left to the user. The caller
 * makes sure nothing of Trackwall runs in the repo; a file another program holds open fails the rename on Windows.
 */

/**
 * Moves `repoDir` into the removed repos folder and returns where it went. `beforeMove` runs right before the rename,
 * after everything else is awaited, so its checks still hold when the folder moves.
 */
export async function moveRepoOut(projectsDir: string, repoDir: string, beforeMove: () => void): Promise<string> {
  const removedDir = trackwallDir(projectsDir, "removed");
  await ensureTrackwallDir(projectsDir);
  await mkdir(removedDir, { recursive: true });
  const target = await freeName(removedDir, basename(repoDir));
  beforeMove();
  try {
    await rename(repoDir, target);
  } catch (err) {
    throw renameError(err, repoDir, process.platform);
  }
  return target;
}

/**
 * On Windows a rename fails with `EBUSY` or `EPERM` while a program holds a file in the folder open, which the user can
 * fix; any other error, and these on other systems (where they mean permissions), passes through as it is.
 */
export function renameError(err: unknown, repoDir: string, platform: NodeJS.Platform): unknown {
  const code = (err as NodeJS.ErrnoException).code;
  if (platform !== "win32" || (code !== "EBUSY" && code !== "EPERM")) return err;
  return new DomainError(
    "bad_request",
    `${repoDir} could not be moved (${code}): a program holds a file in it open, such as an editor, a terminal or a build; close it and approve again`,
  );
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
