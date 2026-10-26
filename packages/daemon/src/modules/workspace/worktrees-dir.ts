import { isAbsolute, join, relative, sep } from "node:path";
import { DomainError } from "../../infra/errors.ts";
import { hasGit } from "./projects-dir.ts";

/**
 * The task worktrees folder (§4.4, ADR-84): where new task worktrees go. By default a hidden folder in the projects
 * folder, so that worktrees sit on the same disk as the repos and fall under the same antivirus exclusion and Copilot CLI
 * trusted folder; the repo list skips it, because it skips names with a dot and has no `.git` itself.
 */

/** The default folder's name in the projects folder. */
const DEFAULT_WORKTREES_DIR_NAME = ".trackwall-worktrees";

export function defaultWorktreesDir(projectsDir: string): string {
  return join(projectsDir, DEFAULT_WORKTREES_DIR_NAME);
}

/**
 * Refuses a folder in which `<folder>/<repo>/<branch>` would land inside a repo of the projects folder: the projects folder
 * itself (a worktree would go into the repo of the same name) or a folder inside one of its repos (git would list the
 * worktrees as untracked files of that repo). A folder outside the projects folder is the user's choice.
 */
export async function checkWorktreesDir(dir: string, projectsDir: string | null): Promise<void> {
  if (projectsDir === null) return;
  const inside = relative(projectsDir, dir);
  if (inside === "") throw new DomainError("bad_request", `${dir} is the projects folder; choose a folder outside the repos`);
  // A folder holding the projects folder would put the worktrees of a repo named like the projects folder right in it.
  if (isInside(relative(dir, projectsDir)))
    throw new DomainError("bad_request", `${dir} holds the projects folder ${projectsDir}; choose a folder outside it`);
  if (!isInside(inside)) return;
  const [child = ""] = inside.split(sep);
  const repo = join(projectsDir, child);
  if (await hasGit(repo)) throw new DomainError("bad_request", `${dir} lies in the repo ${repo}; choose a folder outside the repos`);
}

/** Whether a `relative` result goes down, not up or to another drive; a name such as `..notes` is still inside. */
function isInside(rel: string): boolean {
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
