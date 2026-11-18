import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TrustedProjectsFolder } from "@trackwall/protocol";
import { writeFileAtomic } from "../../infra/atomic-write.ts";
import { DomainError } from "../../infra/errors.ts";
import { COMMENT_LINE, copilotConfigFile, readCopilotConfig, trustedFolderOf } from "./copilot-trust.ts";

/**
 * Adds a folder to the folders Copilot CLI trusts (`trustedFolders` in its `config.json`), the one change the daemon
 * makes to Copilot CLI's configuration (ADR-270, §4.15). It runs only on the user's click in the UI, for the projects
 * folder of the workspace settings, never for a path from a request. It keeps every other key and the comment lines,
 * copies the file as it was next to it first, writes through a temporary file, and refuses a file it cannot read as
 * Copilot CLI's or one that changed while it worked, so nothing of the user's is lost.
 */

/** The copy of `config.json` as it was before the last change, in the same folder; Copilot CLI does not read it. */
export const COPILOT_CONFIG_BACKUP = "config.before-trackwall-trust.json";

/** Only the user reads and writes a `config.json` the daemon creates, as Copilot CLI's own. */
const NEW_FILE_MODE = 0o600;

export type TrustEdit =
  /** A trusted folder covers the folder already: nothing to write. */
  { kind: "covered"; folder: string } | { kind: "edit"; text: string } | { kind: "unreadable"; message: string };

/**
 * `config.json` with `folder` added to `trustedFolders`; `text` is the file now, `null` when there is none. The comment
 * lines Copilot CLI writes before the object stay before it, and the object keeps its keys and their order.
 */
export function withTrustedFolder(text: string | null, folder: string): TrustEdit {
  const read = text === null ? { config: {}, folders: [] } : readCopilotConfig(text);
  if ("problem" in read) return { kind: "unreadable", message: read.problem };
  const covering = trustedFolderOf(folder, read.folders);
  if (covering !== null) return { kind: "covered", folder: covering };
  const comments = (text?.match(COMMENT_LINE) ?? []).map((line) => `${line.trim()}\n`).join("");
  const config = { ...read.config, trustedFolders: [...read.folders, folder] };
  return { kind: "edit", text: `${comments}${JSON.stringify(config, null, 2)}\n` };
}

async function readOrNull(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new DomainError("bad_request", `Copilot CLI's ${file} could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Makes Copilot CLI trust `folder` (and so every folder in it) without asking. */
export async function trustFolder(env: NodeJS.ProcessEnv, folder: string): Promise<TrustedProjectsFolder> {
  const named = copilotConfigFile(env);
  const before = await readOrNull(named);
  const edit = withTrustedFolder(before, folder);
  if (edit.kind === "unreadable")
    throw new DomainError(
      "bad_request",
      `Copilot CLI's ${named} was left as it is (${edit.message}). Correct it, or add the folder by hand.`,
    );
  if (edit.kind === "covered") return { file: named, folder: edit.folder, added: false, backup: null };
  if (before === null) {
    await mkdir(dirname(named), { recursive: true });
    writeFileAtomic(named, edit.text, NEW_FILE_MODE);
    return { file: named, folder, added: true, backup: null };
  }
  // A config.json that is a link stays one: the file it names is the one replaced.
  const file = await realpath(named);
  const mode = (await stat(file)).mode & 0o777;
  const backup = join(dirname(file), COPILOT_CONFIG_BACKUP);
  writeFileAtomic(backup, before, mode);
  // Copilot CLI rewrites the file when a session starts; a file that changed since it was read is read again by a new click.
  if ((await readOrNull(file)) !== before)
    throw new DomainError("bad_request", `Copilot CLI changed ${named} just now, so it was left as it is. Try again.`);
  writeFileAtomic(file, edit.text, mode);
  return { file: named, folder, added: true, backup };
}
