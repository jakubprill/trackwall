import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type DeclaredMiseTask, MISE_LOCAL_CONFIG_FILE } from "@trackwall/protocol";
import { tomlTasks } from "./mise-tasks.ts";

/**
 * The mise tasks of the repo's `mise.local.toml` (ADR-86): the one card input read from the working directory instead of
 * the commit, because the file is local config that git never has. Read on every request, not cached with the card,
 * since it changes without a commit. A file that is missing, unreadable or not valid TOML declares no mise tasks.
 */

/** A local mise config is a few lines; a bigger file is not parsed on every tag request. */
const MAX_BYTES = 256 * 1024;

export async function localMiseTasks(dir: string): Promise<DeclaredMiseTask[]> {
  let text: string;
  try {
    const content = await readFile(join(dir, MISE_LOCAL_CONFIG_FILE));
    if (content.length > MAX_BYTES) return [];
    text = content.toString("utf8");
  } catch {
    return [];
  }
  return tomlTasks(MISE_LOCAL_CONFIG_FILE, text, []);
}
