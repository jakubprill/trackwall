import { join } from "node:path";
import { type DeclaredMiseTask, MAX_LOCAL_CONFIG_BYTES, MISE_CONFIG_FILE, MISE_LOCAL_CONFIG_FILE } from "@trackwall/protocol";
import { readRegularFile } from "../../infra/regular-file.ts";
import { tomlTasks } from "./mise-tasks.ts";

/**
 * The mise tasks of the repo's local mise config (ADR-86, ADR-110): `mise.local.toml`, and `mise.toml` when the HEAD commit
 * does not have it, so the user keeps it out of git. Decided by the commit the card is read from, not by git's index, so
 * the tags cost no git process: a `mise.toml` added to the index and not committed yet still counts as local here. The one card input read from the working directory instead of the
 * commit, because git never has these files. Read on every request, not cached with the card, since they change without
 * a commit, and with the same rules as their backup: a regular file within the size limit, never a link. A file that is
 * missing, refused or not valid TOML declares no mise tasks, as the tags are only a hint.
 */
export async function localMiseTasks(dir: string, committedMiseToml: boolean): Promise<DeclaredMiseTask[]> {
  const files = committedMiseToml ? [MISE_LOCAL_CONFIG_FILE] : [MISE_CONFIG_FILE, MISE_LOCAL_CONFIG_FILE];
  const tasks = await Promise.all(files.map((file) => tasksOf(dir, file)));
  return tasks.flat();
}

async function tasksOf(dir: string, file: string): Promise<DeclaredMiseTask[]> {
  const content = await readRegularFile(join(dir, file), MAX_LOCAL_CONFIG_BYTES).catch(() => undefined);
  return content === undefined ? [] : tomlTasks(file, content.toString("utf8"), []);
}
