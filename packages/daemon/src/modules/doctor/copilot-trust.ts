import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { copilotHome } from "../../infra/copilot-home.ts";
import { isInside } from "../../infra/path-inside.ts";

/**
 * The folders Copilot CLI trusts without asking (`trustedFolders` in `config.json` of its home, `COPILOT_HOME` or
 * `~/.copilot`); an entry covers its subfolders (§4.4). Read here; the one change the daemon makes to Copilot CLI's configuration, on
 * the user's click, is in `copilot-trust-write.ts` (ADR-270).
 */

/**
 * Copilot CLI writes `config.json` with `//` comment lines before the object (seen on 1.0.103 and 1.0.105, pinned by a
 * contract test). A JSON string cannot hold a line break, so a line that starts with `//` is always a comment.
 */
export const COMMENT_LINE = /^\s*\/\/.*$/gm;

/** Any object: the keys other than `trustedFolders` are Copilot CLI's own. */
const ConfigObject = z.record(z.string(), z.unknown());
const FolderList = z.array(z.string()).optional();

/** `config.json` as read: every key as it is and in its order, with the trusted folders, or why it is not Copilot CLI's. */
export type CopilotConfigRead = { config: Record<string, unknown>; folders: string[] } | { problem: string };

/** The one reader of `config.json`'s text, for the check and for "Trust folder". */
export function readCopilotConfig(text: string): CopilotConfigRead {
  let json: unknown;
  try {
    json = JSON.parse(text.replace(COMMENT_LINE, ""));
  } catch {
    return { problem: "not valid JSON" };
  }
  const config = ConfigObject.safeParse(json);
  const folders = FolderList.safeParse(config.success ? config.data.trustedFolders : null);
  if (!config.success || !folders.success) return { problem: "trustedFolders is not a list of folders" };
  return { config: config.data, folders: folders.data ?? [] };
}

export type TrustedFolders =
  | { kind: "read"; file: string; folders: string[] }
  | { kind: "missing"; file: string }
  | { kind: "unreadable"; file: string; message: string };

export function copilotConfigFile(env: NodeJS.ProcessEnv): string {
  return join(copilotHome(env), "config.json");
}

export async function trustedFolders(env: NodeJS.ProcessEnv): Promise<TrustedFolders> {
  const file = copilotConfigFile(env);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing", file };
    return { kind: "unreadable", file, message: err instanceof Error ? err.message : String(err) };
  }
  const read = readCopilotConfig(text);
  return "problem" in read ? { kind: "unreadable", file, message: read.problem } : { kind: "read", file, folders: read.folders };
}

/** The trusted folder that covers `dir`, or `null`. */
export function trustedFolderOf(dir: string, folders: readonly string[]): string | null {
  return folders.find((folder) => isInside(folder, dir)) ?? null;
}
