import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { DroppedFolder } from "@trackwall/protocol";
import { DomainError } from "../../infra/errors.ts";
import { isFullPath } from "./full-path.ts";
import { dirKey, errorCode, findRepos, hasGit, type RepoEntry } from "./projects-dir.ts";

/**
 * A folder dropped on the window (ADR-51): what it is for the repo list, so that the UI can open the repo or offer
 * the folder as the projects folder. Only reads the disk; changing the projects folder stays `setProjectsDir`.
 */
export async function describeDroppedFolder(
  input: string,
  projectsDir: string | null,
  listed: readonly RepoEntry[],
): Promise<DroppedFolder> {
  if (!isFullPath(input)) throw new DomainError("bad_request", `the dropped path must be a full path, got "${input}"`);
  const path = resolve(input);
  const isDir = await stat(path).then(
    (s) => s.isDirectory(),
    (err: unknown) => {
      throw new DomainError("bad_request", `${path} does not exist or cannot be opened (${errorCode(err)})`);
    },
  );
  if (!isDir) return { kind: "file", path };
  const repo = listed.find((entry) => dirKey(entry.path) === dirKey(path));
  if (repo) return { kind: "listed-repo", repo: repo.id };
  if (await hasGit(path)) {
    const parent = dirname(path);
    return { kind: "repo-elsewhere", path, parent, parentRepos: (await reposIn(parent)).length };
  }
  const repos = (await reposIn(path)).length;
  if (repos === 0) return { kind: "no-repos", path };
  return { kind: "folder-with-repos", path, repos, current: projectsDir !== null && dirKey(projectsDir) === dirKey(path) };
}

/** `findRepos` reports an unreadable folder as the projects folder; here it is the folder the user dropped. */
async function reposIn(dir: string): Promise<RepoEntry[]> {
  try {
    return await findRepos(dir);
  } catch (err) {
    if (err instanceof DomainError) throw new DomainError("bad_request", `cannot open ${dir}; check that you can read it`);
    throw err;
  }
}
