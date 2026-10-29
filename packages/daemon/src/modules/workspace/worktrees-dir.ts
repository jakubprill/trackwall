import { isAbsolute, join, relative, sep } from "node:path";
import { TRACKWALL_DIR } from "@trackwall/protocol";
import { DomainError } from "../../infra/errors.ts";
import { trackwallDir } from "../../infra/trackwall-dir.ts";
import { hasGit } from "./projects-dir.ts";

/**
 * The task worktrees folder (§4.4, ADR-84): where new task worktrees go. By default a folder of `.trackwall` in the
 * projects folder (ADR-125), so that worktrees sit on the same disk as the repos and fall under the same antivirus exclusion and Copilot CLI
 * trusted folder; the repo list skips it, because it skips names with a dot and has no `.git` itself.
 */

export function defaultWorktreesDir(projectsDir: string): string {
  return trackwallDir(projectsDir, "worktrees");
}

/**
 * Refuses a folder in which `<folder>/<repo>/<branch>` would land inside a repo of the projects folder: the projects folder
 * itself (a worktree would go into the repo of the same name) or a folder inside one of its repos (git would list the
 * worktrees as untracked files of that repo), and a folder of `.trackwall` other than its worktrees folder (a worktree
 * would go into the local config store's repo, or among Trackwall's own folders, ADR-125). A folder outside the projects
 * folder is the user's choice.
 */
export async function checkWorktreesDir(dir: string, projectsDir: string | null): Promise<void> {
  if (projectsDir === null) return;
  const inside = relative(projectsDir, dir);
  if (inside === "")
    throw new DomainError("bad_request", `${dir} is the projects folder; choose a task worktrees folder outside the repos in Settings`);
  // A folder holding the projects folder would put the worktrees of a repo named like the projects folder right in it.
  if (isInside(relative(dir, projectsDir)))
    throw new DomainError(
      "bad_request",
      `${dir} holds the projects folder ${projectsDir}; choose a task worktrees folder outside it in Settings`,
    );
  if (!isInside(inside)) return;
  const trackwall = join(projectsDir, TRACKWALL_DIR);
  if ((relative(trackwall, dir) === "" || isInside(relative(trackwall, dir))) && !isInsideOrSame(defaultWorktreesDir(projectsDir), dir))
    throw new DomainError(
      "bad_request",
      `${dir} lies in Trackwall's own folder ${trackwall}; choose its worktrees folder or a folder outside the repos in Settings`,
    );
  const [child = ""] = inside.split(sep);
  const repo = join(projectsDir, child);
  if (await hasGit(repo))
    throw new DomainError("bad_request", `${dir} lies in the repo ${repo}; choose a task worktrees folder outside the repos in Settings`);
}

function isInsideOrSame(parent: string, dir: string): boolean {
  const rel = relative(parent, dir);
  return rel === "" || isInside(rel);
}

/** Whether a `relative` result goes down, not up or to another drive; a name such as `..notes` is still inside. */
function isInside(rel: string): boolean {
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
