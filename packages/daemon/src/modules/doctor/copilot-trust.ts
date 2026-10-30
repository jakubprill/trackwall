import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { envKey } from "../../infra/env-key.ts";
import { isInside } from "../../infra/path-inside.ts";

/**
 * The folders Copilot CLI trusts without asking (`trustedFolders` in `config.json` of its home, `COPILOT_HOME` or
 * `~/.copilot`); an entry covers its subfolders (§4.4). Only read: the daemon never changes Copilot CLI's configuration.
 */

/**
 * Copilot CLI writes `config.json` with `//` comment lines before the object (seen on 1.0.103 and 1.0.105, pinned by a
 * contract test). A JSON string cannot hold a line break, so a line that starts with `//` is always a comment.
 */
const COMMENT_LINE = /^\s*\/\/.*$/gm;

const CopilotConfig = z.object({ trustedFolders: z.array(z.string()).optional() });

export type TrustedFolders =
  | { kind: "read"; file: string; folders: string[] }
  | { kind: "missing"; file: string }
  | { kind: "unreadable"; file: string; message: string };

/** Copilot CLI's home: `COPILOT_HOME` (in any case on Windows) when set and not empty, otherwise `~/.copilot`. */
export function copilotHome(env: NodeJS.ProcessEnv): string {
  const home = env[envKey(env, "COPILOT_HOME")];
  return home ? home : join(homedir(), ".copilot");
}

function copilotConfigFile(env: NodeJS.ProcessEnv): string {
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
  try {
    const parsed = CopilotConfig.safeParse(JSON.parse(text.replace(COMMENT_LINE, "")));
    if (!parsed.success) return { kind: "unreadable", file, message: "trustedFolders is not a list of folders" };
    return { kind: "read", file, folders: parsed.data.trustedFolders ?? [] };
  } catch {
    return { kind: "unreadable", file, message: "not valid JSON" };
  }
}

/** The trusted folder that covers `dir`, or `null`. */
export function trustedFolderOf(dir: string, folders: readonly string[]): string | null {
  return folders.find((folder) => isInside(folder, dir)) ?? null;
}
