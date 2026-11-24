import { basename, join } from "node:path";
import { isMap, parseDocument } from "yaml";
import { messageOf } from "../../infra/errors.ts";
import type { FileCopy, FolderCopies } from "../../infra/named-file-folder.ts";
import { readRegularFile } from "../../infra/regular-file.ts";
import { isReference, isSecretName, MASKED, maskArgs, maskString } from "./secret-masking.ts";

/**
 * The copies of the user's own setup the workspace store keeps while the user allows it (§4.13, ADR-299): `workspace.yaml`
 * in `trackwall/` and the Copilot CLI user files task sessions depend on in `copilot/`, masked by `secret-masking.ts`.
 * A file whose shape the masking does not know (a key or a type of a server it has no rule for, YAML or JSON it cannot
 * read) is held: the store keeps the version it has, and never one that was not masked. `copilot-instructions.md` is the
 * user's prose and goes in as written.
 */

/** The Copilot CLI user files the store keeps, in Copilot CLI's home (`COPILOT_HOME` or `~/.copilot`). */
export const COPILOT_USER_FILES = ["settings.json", "copilot-instructions.md", "mcp-config.json"] as const;

/** A settings file is a few kilobytes; one past this is not the user's setup, and the store keeps what it has. */
export const MAX_SETTINGS_FILE_BYTES = 1024 * 1024;

/** What each key of a server in `mcp-config.json` must hold; any other key, or another type, holds the file. */
const SERVER_SHAPE = new Map<string, (value: unknown) => boolean>([
  ["type", isString],
  ["command", isString],
  ["cwd", isString],
  ["url", isString],
  ["timeout", (value) => typeof value === "number"],
  ["tools", isStringArray],
  ["args", isStringArray],
  ["env", isStringRecord],
  ["headers", isStringRecord],
]);

/** `workspace.yaml` as `trackwall/workspace.yaml`; nothing when the file is not there yet. */
export async function workspaceFileCopies(path: string): Promise<FolderCopies> {
  return copies([path], (_file, bytes) => maskWorkspaceFile(bytes));
}

/** The Copilot CLI user files in `copilotHome` that are there, as `copilot/<file>`. */
export async function copilotCopies(copilotHome: string): Promise<FolderCopies> {
  return copies(
    COPILOT_USER_FILES.map((file) => join(copilotHome, file)),
    maskCopilotFile,
  );
}

/** A Copilot CLI user file as the store keeps it; an error when its secrets cannot be found. */
export function maskCopilotFile(file: string, bytes: Buffer): Buffer {
  if (file === "mcp-config.json") return maskMcpConfig(bytes);
  if (file === "settings.json") return maskCopilotSettings(bytes);
  return bytes;
}

async function copies(paths: readonly string[], mask: (file: string, bytes: Buffer) => Buffer): Promise<FolderCopies> {
  const result: { copies: FileCopy[]; held: string[]; problems: string[] } = { copies: [], held: [], problems: [] };
  for (const path of paths) {
    const file = basename(path);
    try {
      const bytes = await readRegularFile(path, MAX_SETTINGS_FILE_BYTES);
      if (bytes !== undefined) result.copies.push({ file, bytes: mask(file, bytes) });
    } catch (err) {
      result.held.push(file);
      result.problems.push(`${path}: ${messageOf(err)}`);
    }
  }
  return result;
}

/**
 * `workspace.yaml` with the address of `localConfigRemote` (ADR-127) masked; the file's own bytes, comments and all, when
 * there is nothing to take out. A file that is not valid YAML is refused, since where its values are cannot be told.
 */
export function maskWorkspaceFile(bytes: Buffer): Buffer {
  const doc = parseDocument(bytes.toString("utf8"));
  // The parser's message quotes the file, so only the place goes into the problem.
  const [error] = doc.errors;
  if (error !== undefined) throw new Error(`not valid YAML at line ${error.linePos?.[0].line ?? "?"}, so its secrets cannot be masked`);
  if (!isMap(doc.contents)) return bytes;
  const remote: unknown = doc.get("localConfigRemote");
  if (typeof remote !== "string" || maskString(remote) === remote) return bytes;
  doc.set("localConfigRemote", maskString(remote));
  return Buffer.from(doc.toString(), "utf8");
}

/**
 * Copilot CLI's `settings.json` with every string under a key named like a secret masked, at any depth, and every other
 * string masked as a free string (an address, a prefixed token).
 */
export function maskCopilotSettings(bytes: Buffer): Buffer {
  const settings = parseJson(bytes);
  const masked = maskJson(settings, false);
  return JSON.stringify(masked) === JSON.stringify(settings) ? bytes : json(masked);
}

/** `value` with its strings masked; every one of them under a secret key when `secret`. */
function maskJson(value: unknown, secret: boolean): unknown {
  if (typeof value === "string") return secret && !isReference(value) ? MASKED : maskString(value);
  if (Array.isArray(value)) return value.map((item) => maskJson(item, secret));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, maskJson(inner, secret || isSecretName(key))]));
}

/**
 * `mcp-config.json` with its servers' secrets masked: every value of `env` and `headers` that is not a reference, the
 * arguments (`maskArgs`), and the address, command and folder as free strings. A file that is not JSON, or has a key or a
 * type the masking has no rule for, is refused rather than copied.
 */
export function maskMcpConfig(bytes: Buffer): Buffer {
  const config = parseJson(bytes);
  if (!isRecord(config)) throw new Error("not a JSON object, so its secrets cannot be masked");
  const unknown = Object.keys(config).filter((key) => key !== "mcpServers");
  if (unknown.length > 0) throw new Error(`has ${unknown.join(", ")}, which Trackwall does not know, so its secrets cannot be masked`);
  const servers = config.mcpServers;
  if (servers === undefined) return bytes;
  if (!isRecord(servers)) throw new Error("mcpServers is not an object, so its secrets cannot be masked");
  const masked = Object.fromEntries(Object.entries(servers).map(([name, server]) => [name, maskServer(name, server)]));
  return JSON.stringify(masked) === JSON.stringify(servers) ? bytes : json({ mcpServers: masked });
}

/** One server with its secrets masked. */
function maskServer(name: string, server: unknown): Record<string, unknown> {
  if (!isRecord(server)) throw new Error(`server ${name} is not an object, so its secrets cannot be masked`);
  const unknown = Object.entries(server).filter(([key, value]) => !(SERVER_SHAPE.get(key)?.(value) ?? false));
  if (unknown.length > 0) {
    const keys = unknown.map(([key]) => key).join(", ");
    throw new Error(`server ${name} has ${keys} in a form Trackwall does not know, so its secrets cannot be masked`);
  }
  return Object.fromEntries(Object.entries(server).map(([key, value]) => [key, maskServerValue(key, value)]));
}

function maskServerValue(key: string, value: unknown): unknown {
  if (key === "env" || key === "headers")
    return isStringRecord(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, isReference(v) ? v : MASKED])) : value;
  if (key === "args") return isStringArray(value) ? maskArgs(value) : value;
  if (key === "url" || key === "command" || key === "cwd") return typeof value === "string" ? maskString(value) : value;
  return value;
}

/** The parser's message quotes the file, so the problem says only that it is not JSON. */
function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("not valid JSON, so its secrets cannot be masked");
  }
}

function json(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(isString);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
