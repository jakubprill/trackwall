import { basename, join } from "node:path";
import { withoutUserInfo } from "@trackwall/protocol";
import { isMap, parseDocument } from "yaml";
import { messageOf } from "../../infra/errors.ts";
import type { FileCopy, FolderCopies } from "../../infra/named-file-folder.ts";
import { readRegularFile } from "../../infra/regular-file.ts";

/**
 * The copies of the user's own setup the workspace store keeps while the user allows it (§4.13, ADR-299): `workspace.yaml`
 * in `trackwall/` and the Copilot CLI user files task sessions depend on in `copilot/`. The store's folder is one an agent
 * can read and its remote may be a server the user shares, so no secret goes in: a literal value in `mcp-config.json`'s
 * `env` and `headers` becomes `MASKED`, a reference such as `${GITLAB_TOKEN}` stays, and an address loses its user and
 * token. A file that cannot be read, or masked, is held: the store keeps the version it has, and never an unmasked one.
 */

/** What a masked value becomes: the user fills the real one in after a restore. */
export const MASKED = "<masked by Trackwall: fill in on this computer>";

/** The Copilot CLI user files the store keeps, in Copilot CLI's home (`COPILOT_HOME` or `~/.copilot`). */
const COPILOT_USER_FILES = ["settings.json", "copilot-instructions.md", "mcp-config.json"] as const;

/** The MCP servers file, the only one with values to mask. */
const MCP_CONFIG = "mcp-config.json";

/** A settings file is a few kilobytes; one past this is not the user's setup, and the store keeps what it has. */
const MAX_SETTINGS_FILE_BYTES = 1024 * 1024;

/**
 * A value that names a secret rather than holding one: only references (`${NAME}`, `$NAME`), optionally after an
 * authentication scheme (`Bearer ${TOKEN}`), which Copilot CLI fills in from the environment.
 */
const REFERENCE = /^(?:[A-Za-z]+ )?(?:\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*)$/;

/** An argument whose name says it carries a secret: `--token`, `--api-key=…`, `--password`. */
const SECRET_FLAG = /^--?[A-Za-z0-9_-]*(?:token|secret|password|passwd|api[-_]?key|auth)[A-Za-z0-9_-]*$/i;

export interface SettingsCopies extends FolderCopies {
  /** Why a held file was held, for the store's problem; empty when nothing was. */
  problems: string[];
}

/** `workspace.yaml` as `trackwall/workspace.yaml`; nothing when the file is not there yet. */
export async function workspaceFileCopies(path: string): Promise<SettingsCopies> {
  return copies([path], maskWorkspaceFile);
}

/** The Copilot CLI user files in `copilotHome` that are there, as `copilot/<file>`. */
export async function copilotCopies(copilotHome: string): Promise<SettingsCopies> {
  return copies(
    COPILOT_USER_FILES.map((file) => join(copilotHome, file)),
    (file, bytes) => (file === MCP_CONFIG ? maskMcpConfig(bytes) : bytes),
  );
}

async function copies(paths: readonly string[], mask: (file: string, bytes: Buffer) => Buffer): Promise<SettingsCopies> {
  const result: SettingsCopies = { copies: [], held: [], problems: [] };
  for (const path of paths) {
    const file = basename(path);
    try {
      const bytes = await readRegularFile(path, MAX_SETTINGS_FILE_BYTES);
      if (bytes !== undefined) result.copies.push({ file, bytes: mask(file, bytes) } satisfies FileCopy);
    } catch (err) {
      result.held.push(file);
      result.problems.push(`${path}: ${messageOf(err)}`);
    }
  }
  return result;
}

/**
 * `workspace.yaml` with `localConfigRemote` (ADR-127) without the user and token an HTTPS address may carry; the file's
 * own bytes, comments and all, when there is nothing to take out. The daemon reads only valid YAML, so a file that is not
 * is copied as it is: it holds no value the daemon would use.
 */
export function maskWorkspaceFile(_file: string, bytes: Buffer): Buffer {
  const doc = parseDocument(bytes.toString("utf8"));
  if (doc.errors.length > 0 || !isMap(doc.contents)) return bytes;
  const remote: unknown = doc.get("localConfigRemote");
  if (typeof remote !== "string" || withoutUserInfo(remote) === remote) return bytes;
  doc.set("localConfigRemote", withoutUserInfo(remote));
  return Buffer.from(doc.toString(), "utf8");
}

/**
 * `mcp-config.json` with every literal value of a server's `env` and `headers`, and of an argument named like a secret,
 * replaced by `MASKED`, and a server's `url` without user and token. A file that is not JSON cannot be checked for
 * secrets, so it is refused rather than copied.
 */
export function maskMcpConfig(bytes: Buffer): Buffer {
  let config: unknown;
  try {
    config = JSON.parse(bytes.toString("utf8"));
  } catch (err) {
    throw new Error(`not valid JSON, so its secrets cannot be masked: ${messageOf(err)}`);
  }
  const servers = isRecord(config) ? config.mcpServers : undefined;
  if (!isRecord(servers)) return bytes;
  let changed = false;
  for (const server of Object.values(servers)) if (isRecord(server)) changed = maskServer(server) || changed;
  return changed ? Buffer.from(`${JSON.stringify(config, null, 2)}\n`, "utf8") : bytes;
}

/** Masks one server's secrets in place; whether anything changed. */
function maskServer(server: Record<string, unknown>): boolean {
  let changed = maskValues(server.env);
  changed = maskValues(server.headers) || changed;
  const args: unknown = server.args;
  if (Array.isArray(args)) {
    const masked = maskArgs(args);
    changed = masked.some((arg, i) => arg !== args[i]) || changed;
    server.args = masked;
  }
  if (typeof server.url === "string" && withoutUserInfo(server.url) !== server.url) {
    server.url = withoutUserInfo(server.url);
    changed = true;
  }
  return changed;
}

/** Every value of `values` that is not a reference becomes `MASKED`, in place; whether any did. */
function maskValues(values: unknown): boolean {
  if (!isRecord(values)) return false;
  let changed = false;
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === "string" && REFERENCE.test(value)) continue;
    values[name] = MASKED;
    changed = true;
  }
  return changed;
}

/** `--token abc` and `--token=abc` keep the flag and lose the value; a reference stays. */
function maskArgs(args: readonly unknown[]): unknown[] {
  return args.map((arg, i) => {
    if (typeof arg !== "string") return arg;
    const eq = arg.indexOf("=");
    if (eq > 0 && SECRET_FLAG.test(arg.slice(0, eq))) return REFERENCE.test(arg.slice(eq + 1)) ? arg : `${arg.slice(0, eq + 1)}${MASKED}`;
    const before = args[i - 1];
    if (typeof before === "string" && SECRET_FLAG.test(before) && !arg.startsWith("-") && !REFERENCE.test(arg)) return MASKED;
    return arg;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
