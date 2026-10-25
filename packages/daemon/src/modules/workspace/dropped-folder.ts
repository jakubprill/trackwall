import { basename, dirname, resolve, sep } from "node:path";
import type { DroppedFolder } from "@trackwall/protocol";
import { DomainError } from "../../infra/errors.ts";
import { dirKey, findRepos, hasGit, projectsDirUnavailable, type RepoEntry, statFullPath } from "./projects-dir.ts";

/**
 * A folder dropped on the window (ADR-51): what it is for the repo list, so that the UI can open the repo or offer
 * the folder as the projects folder. Only reads the disk; changing the projects folder stays `setProjectsDir`.
 */
export async function describeDroppedFolder(input: string, projectsDir: string | null): Promise<DroppedFolder> {
  const { path, isDir } = await statFullPath(input, "the dropped path must be a full path");
  if (!isDir) return { kind: "file", path };
  const key = dirKey(path);
  // `projectsDir` may come from a hand-edited `workspace.yaml`, with a trailing separator or `/` on Windows.
  if (projectsDir !== null && dirKey(resolve(projectsDir)) === key) return { kind: "projects-dir" };
  // A folder inside a listed repo (e.g. its `src`) is that repo too.
  const repo = (await listedRepos(projectsDir)).find((entry) => key === dirKey(entry.path) || key.startsWith(dirKey(entry.path) + sep));
  if (repo) return { kind: "listed-repo", repo: repo.id };
  if (await hasGit(path)) {
    // The list skips names with a dot (ADR-18), so the folder that holds such a repo would not list it either.
    if (basename(path).startsWith(".")) return { kind: "hidden-repo", path };
    const parent = dirname(path);
    return { kind: "repo-elsewhere", path, parent, parentRepos: (await reposIn(parent)).length };
  }
  const repos = (await reposIn(path)).length;
  return repos === 0 ? { kind: "no-repos", path } : { kind: "folder-with-repos", path, repos };
}

/**
 * The repos of the projects folder, read only when needed: a dropped file or the projects folder itself does not wait
 * for a scan of a slow disk. A projects folder that is gone has none; dropping a folder is one way to replace it.
 */
async function listedRepos(projectsDir: string | null): Promise<RepoEntry[]> {
  if (projectsDir === null) return [];
  try {
    return await findRepos(projectsDir, projectsDirUnavailable);
  } catch (err) {
    if (err instanceof DomainError && err.code === "projects_dir_unavailable") return [];
    throw err;
  }
}

function reposIn(dir: string): Promise<RepoEntry[]> {
  return findRepos(
    dir,
    (unreadable, code) => new DomainError("bad_request", `cannot open ${unreadable} (${code}); check that you can read it`),
  );
}
