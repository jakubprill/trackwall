import { join } from "node:path";
import { type DeclaredMiseTask, MAX_LOCAL_CONFIG_BYTES, MISE_LOCAL_CONFIG_FILE } from "@trackwall/protocol";
import { readRegularFile } from "../../infra/regular-file.ts";
import { tomlTasks } from "./mise-tasks.ts";

/**
 * The mise tasks of the repo's `mise.local.toml` (ADR-86): the one card input read from the working directory instead of
 * the commit, because the file is local config that git never has. Read on every request, not cached with the card,
 * since it changes without a commit, and with the same rules as its backup: a regular file within the size limit, never
 * a link. A file that is missing, refused or not valid TOML declares no mise tasks, as the tag is only a hint.
 */
export async function localMiseTasks(dir: string): Promise<DeclaredMiseTask[]> {
  const content = await readRegularFile(join(dir, MISE_LOCAL_CONFIG_FILE), MAX_LOCAL_CONFIG_BYTES).catch(() => undefined);
  return content === undefined ? [] : tomlTasks(MISE_LOCAL_CONFIG_FILE, content.toString("utf8"), []);
}
