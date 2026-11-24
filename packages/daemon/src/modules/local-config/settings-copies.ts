import { basename, join } from "node:path";
import { isMap, parseDocument } from "yaml";
import { messageOf } from "../../infra/errors.ts";
import type { FileCopy, FolderCopies } from "../../infra/named-file-folder.ts";
import { readRegularFile } from "../../infra/regular-file.ts";

/**
 * The copies of the user's own setup the workspace store keeps while the user allows it (§4.13, ADR-299): `workspace.yaml`
 * in `trackwall/` and the Copilot CLI user files task sessions depend on in `copilot/`. The store can be read by any
 * session and its remote may be a server the user shares, so no secret goes in. Masking is by place: in `mcp-config.json`
 * every value of `env` and `headers`, the value of an argument that carries a header, a variable or a secret, a string
 * value of a `settings.json` key named like a secret, and the user, token, query and fragment of every address become
 * `MASKED`, unless the value only names an environment variable (`${GITLAB_TOKEN}`). A file whose shape the masking does
 * not know (a key of a server it has no rule for, YAML or JSON it cannot read) is held: the store keeps the version it has,
 * and never one that was not masked. `copilot-instructions.md` is the user's prose and goes in as written.
 */

/** What a masked value becomes: the user fills the real one in after a restore. */
export const MASKED = "<masked by Trackwall: fill in on this computer>";

/** The Copilot CLI user files the store keeps, in Copilot CLI's home (`COPILOT_HOME` or `~/.copilot`). */
const COPILOT_USER_FILES = ["settings.json", "copilot-instructions.md", "mcp-config.json"] as const;

/** A settings file is a few kilobytes; one past this is not the user's setup, and the store keeps what it has. */
const MAX_SETTINGS_FILE_BYTES = 1024 * 1024;

/**
 * A value that names a secret rather than holding one: an environment variable (`${NAME}`, `$NAME`, upper case, as
 * Copilot CLI fills it in), optionally after a scheme (`Bearer ${TOKEN}`) or a header's or variable's name
 * (`Authorization: Bearer ${TOKEN}`, `GITHUB_TOKEN=${GITHUB_TOKEN}`).
 */
const REFERENCE = /^(?:[A-Za-z0-9_-]+\s*[:=]\s*)?(?:(?:Bearer|Basic|Token) )?(?:\$\{[A-Z_][A-Z0-9_]*\}|\$[A-Z_][A-Z0-9_]*)$/;

/** A name that says its value is a secret: `--token`, `API_KEY`, `password`. */
const SECRET_NAME = /token|secret|password|passwd|api[-_]?key/i;

/** An argument whose value is a secret by its name, or carries a header or a variable that may be one. */
const SECRET_FLAG = /^--?(?:[A-Za-z0-9_-]*(?:token|secret|password|passwd|api[-_]?key|auth)[A-Za-z0-9_-]*|H|header|e|env)$/i;

/** The keys of a server in `mcp-config.json` the masking has a rule for; any other key holds the file. */
const SERVER_KEYS = new Set(["type", "command", "args", "env", "headers", "url", "tools", "timeout", "cwd"]);

/** An address with a scheme, whose user, query and fragment may carry a token. */
const ADDRESS = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)(?:([^/?#]*)@)?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/s;

/** `workspace.yaml` as `trackwall/workspace.yaml`; nothing when the file is not there yet. */
export async function workspaceFileCopies(path: string): Promise<FolderCopies> {
  return copies([path], (_file, bytes) => maskWorkspaceFile(bytes));
}

/** The Copilot CLI user files in `copilotHome` that are there, as `copilot/<file>`. */
export async function copilotCopies(copilotHome: string): Promise<FolderCopies> {
  return copies(
    COPILOT_USER_FILES.map((file) => join(copilotHome, file)),
    (file, bytes) => (file === "mcp-config.json" ? maskMcpConfig(bytes) : file === "settings.json" ? maskCopilotSettings(bytes) : bytes),
  );
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
  if (typeof remote !== "string" || maskAddress(remote) === remote) return bytes;
  doc.set("localConfigRemote", maskAddress(remote));
  return Buffer.from(doc.toString(), "utf8");
}

/** Copilot CLI's `settings.json` with every string value of a key named like a secret masked, at any depth. */
export function maskCopilotSettings(bytes: Buffer): Buffer {
  const settings = parseJson(bytes);
  return maskSecretKeys(settings) ? json(settings) : bytes;
}

/**
 * `mcp-config.json` with its servers' secrets masked (see the module's comment). A file that is not JSON, or has a key
 * the masking has no rule for, is refused rather than copied.
 */
export function maskMcpConfig(bytes: Buffer): Buffer {
  const config = parseJson(bytes);
  if (!isRecord(config)) throw new Error("not a JSON object, so its secrets cannot be masked");
  const unknown = Object.keys(config).filter((key) => key !== "mcpServers");
  if (unknown.length > 0) throw new Error(`has ${unknown.join(", ")}, which Trackwall does not know, so its secrets cannot be masked`);
  const servers = config.mcpServers;
  if (servers === undefined) return bytes;
  if (!isRecord(servers)) throw new Error("mcpServers is not an object, so its secrets cannot be masked");
  let changed = false;
  for (const [name, server] of Object.entries(servers)) changed = maskServer(name, server) || changed;
  return changed ? json(config) : bytes;
}

/** Masks one server's secrets in place; whether anything changed. */
function maskServer(name: string, server: unknown): boolean {
  if (!isRecord(server)) throw new Error(`server ${name} is not an object, so its secrets cannot be masked`);
  const unknown = Object.keys(server).filter((key) => !SERVER_KEYS.has(key));
  if (unknown.length > 0)
    throw new Error(`server ${name} has ${unknown.join(", ")}, which Trackwall does not know, so its secrets cannot be masked`);
  let changed = maskValues(server.env);
  changed = maskValues(server.headers) || changed;
  const args: unknown = server.args;
  if (Array.isArray(args)) {
    const masked = maskArgs(args);
    changed = masked.some((arg, i) => arg !== args[i]) || changed;
    server.args = masked;
  }
  if (typeof server.url === "string" && maskAddress(server.url) !== server.url) {
    server.url = maskAddress(server.url);
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

/**
 * `--token abc`, `--token=abc`, `-H "Authorization: Bearer abc"`, `-e GITHUB_TOKEN=abc` and `API_KEY=abc` keep the flag
 * or name and lose the value; a reference stays, and an address is masked wherever it is.
 */
function maskArgs(args: readonly unknown[]): unknown[] {
  return args.map((arg, i) => (typeof arg === "string" ? maskArg(arg, args[i - 1]) : arg));
}

/** One argument, after `before`, the argument before it. */
function maskArg(arg: string, before: unknown): string {
  if (typeof before === "string" && SECRET_FLAG.test(before) && !arg.startsWith("-")) return REFERENCE.test(arg) ? arg : MASKED;
  const eq = arg.indexOf("=");
  const name = arg.slice(0, Math.max(eq, 0));
  const secret = eq > 0 && (SECRET_FLAG.test(name) || (!name.startsWith("-") && SECRET_NAME.test(name)));
  if (!secret) return maskAddress(arg);
  return REFERENCE.test(arg.slice(eq + 1)) ? arg : `${name}=${MASKED}`;
}

/** An address of any scheme without its token (an HTTP user, any password), and with every value of its query and its fragment masked. */
export function maskAddress(text: string): string {
  const match = ADDRESS.exec(text);
  if (!match) return text;
  const [, scheme = "", user, rest = "", query, fragment] = match;
  // An HTTP address's user may be a token by itself; elsewhere only a password is a secret, so `ssh://git@host` stays.
  const keepUser = user !== undefined && !/^https?:/i.test(scheme) && !user.includes(":");
  return `${scheme}${keepUser ? `${user}@` : ""}${rest}${maskedQuery(query)}${maskedFragment(fragment)}`;
}

/** `?a=MASKED&b=${B}`: every value that is not a reference masked; nothing without a query. */
function maskedQuery(query: string | undefined): string {
  if (query === undefined) return "";
  const params = query.split("&").map((param) => {
    const eq = param.indexOf("=");
    return eq < 0 || REFERENCE.test(param.slice(eq + 1)) ? param : `${param.slice(0, eq)}=${MASKED}`;
  });
  return `?${params.join("&")}`;
}

/** A fragment may carry a token (`#token=…`), so a non-empty one is masked whole. */
function maskedFragment(fragment: string | undefined): string {
  if (fragment === undefined) return "";
  return fragment === "" ? "#" : `#${MASKED}`;
}

/** Masks, in place, every string value under a key named like a secret; whether any was. */
function maskSecretKeys(value: unknown): boolean {
  if (Array.isArray(value)) return value.map(maskSecretKeys).some(Boolean);
  if (!isRecord(value)) return false;
  let changed = false;
  for (const [key, inner] of Object.entries(value)) {
    if (typeof inner === "string" && SECRET_NAME.test(key) && !REFERENCE.test(inner)) {
      value[key] = MASKED;
      changed = true;
    } else changed = maskSecretKeys(inner) || changed;
  }
  return changed;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
