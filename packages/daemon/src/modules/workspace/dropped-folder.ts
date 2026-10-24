import { dirname, sep } from "node:path";
import type { DroppedFolder } from "@trackwall/protocol";
import { DomainError } from "../../infra/errors.ts";
import { dirKey, findRepos, hasGit, type RepoEntry, statFullPath } from "./projects-dir.ts";

/**
 * A folder dropped on the window (ADR-51): what it is for the repo list, so that the UI can open the repo or offer
 * the folder as the projects folder. Only reads the disk; changing the projects folder stays `setProjectsDir`.
 */
export async function describeDroppedFolder(
  input: string,
  projectsDir: string | null,
  listed: readonly RepoEntry[],
): Promise<DroppedFolder> {
  const { path, isDir } = await statFullPath(input, "the dropped path must be a full path");
  if (!isDir) return { kind: "file", path };
  const key = dirKey(path);
  if (projectsDir !== null && dirKey(projectsDir) === key) return { kind: "projects-dir" };
  // A folder inside a listed repo (e.g. its `src`) is that repo too.
  const repo = listed.find((entry) => key === dirKey(entry.path) || key.startsWith(dirKey(entry.path) + sep));
  if (repo) return { kind: "listed-repo", repo: repo.id };
  if (await hasGit(path)) {
    const parent = dirname(path);
    if (projectsDir !== null && dirKey(parent) === dirKey(projectsDir)) return { kind: "hidden-repo", path };
    return { kind: "repo-elsewhere", path, parent, parentRepos: (await reposIn(parent)).length };
  }
  const repos = (await reposIn(path)).length;
  return repos === 0 ? { kind: "no-repos", path } : { kind: "folder-with-repos", path, repos };
}

function reposIn(dir: string): Promise<RepoEntry[]> {
  return findRepos(
    dir,
    (unreadable, code) => new DomainError("bad_request", `cannot open ${unreadable} (${code}); check that you can read it`),
  );
}
