import { lstat } from "node:fs/promises";
import type { TerminalPlace } from "@trackwall/protocol";
import { DomainError } from "../../infra/errors.ts";

/**
 * The folder of a place for a folder terminal and for its files (§4.23): a repo root as the workspace has it, and a task's
 * worktree only as a folder of its own, since its agent could swap the worktree for a link to anywhere, such as the home
 * folder.
 */
export async function checkedPlaceFolder(place: TerminalPlace, folder: string): Promise<string> {
  if (place.task === null) return folder;
  const stat = await lstat(folder).catch(() => undefined);
  if (stat === undefined || !stat.isDirectory())
    throw new DomainError("repo_unavailable", `${folder} is not a folder (it is gone, or a link)`);
  return folder;
}
