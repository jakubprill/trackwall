import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { MCP_AUDIT_MAX_ARG_CHARS, MCP_AUDIT_MAX_CALLS, MCP_AUDIT_MAX_ERROR_CHARS, McpCall, type McpCallList } from "@trackwall/protocol";
import { messageOf } from "../../infra/errors.ts";

/**
 * The `mcp-audit` module (ADR-152): every MCP tool call the daemon answered, so the person can see what agents did
 * through Trackwall, also after a restart. A call is one JSON line appended to `logs/mcp-calls.jsonl` in the state
 * directory as it ends; at `MAX_FILE_BYTES` the file becomes `mcp-calls.prev.jsonl` and a new one starts, so the audit
 * takes at most twice that on disk. The last `MCP_AUDIT_MAX_CALLS` calls stay in memory, read back from both files at
 * the start. Only what the tool's contract names as identifier arguments comes in (`auditArgs`), and every value and
 * error text is cut here, whatever the caller passes. Nothing leaves the computer, and no MCP tool reads it: the audit
 * is for the person, not for an agent to learn what other agents did.
 */

const FILE = "mcp-calls.jsonl";
const PREVIOUS_FILE = "mcp-calls.prev.jsonl";
/** About 3000 calls of a few hundred bytes: far more than the calls kept in memory, so a rotation never loses those. */
const MAX_FILE_BYTES = 1024 * 1024;
/** A file larger than this was not written by the audit (or by an older, unbounded one): it is not read at the start. */
const MAX_READ_BYTES = 4 * MAX_FILE_BYTES;

export interface McpAuditDeps {
  /** The state directory's `logs/`. */
  dir: string;
  log: (msg: string) => void;
}

export class McpAudit {
  readonly #deps: McpAuditDeps;
  readonly #file: string;
  readonly #calls: McpCall[];
  #fileBytes: number;
  #revision = 0;

  constructor(deps: McpAuditDeps) {
    this.#deps = deps;
    this.#file = join(deps.dir, FILE);
    this.#calls = [...this.#read(join(deps.dir, PREVIOUS_FILE)), ...this.#read(this.#file)].slice(-MCP_AUDIT_MAX_CALLS);
    this.#fileBytes = sizeOf(this.#file);
  }

  /** Never throws: it runs on the path that answers the agent, which a full disk must not break. */
  record(call: McpCall): void {
    const kept = bounded(call);
    this.#calls.push(kept);
    if (this.#calls.length > MCP_AUDIT_MAX_CALLS) this.#calls.shift();
    this.#revision++;
    try {
      this.#append(`${JSON.stringify(kept)}\n`);
    } catch (err) {
      this.#deps.log(`failed to write the MCP audit: ${messageOf(err)}`);
    }
  }

  /** Newest first; with `task`, only the calls of that task's sessions. */
  list(task?: string): McpCallList {
    const calls = task === undefined ? this.#calls : this.#calls.filter((c) => c.caller?.task === task);
    return { calls: [...calls].reverse() };
  }

  /** Grows with every recorded call, for the `mcp.calls.changed` topic. */
  revision(): number {
    return this.#revision;
  }

  #append(line: string): void {
    const bytes = Buffer.byteLength(line);
    if (this.#fileBytes > 0 && this.#fileBytes + bytes > MAX_FILE_BYTES) {
      renameSync(this.#file, join(this.#deps.dir, PREVIOUS_FILE));
      this.#fileBytes = 0;
    }
    mkdirSync(this.#deps.dir, { recursive: true });
    appendFileSync(this.#file, line);
    this.#fileBytes += bytes;
  }

  /** The calls of one file; a line that is not a call (cut by a crash mid-write, edited by hand) is skipped. */
  #read(path: string): McpCall[] {
    const size = sizeOf(path);
    if (size === 0) return [];
    if (size > MAX_READ_BYTES) {
      this.#deps.log(`the MCP audit file ${path} has ${size} bytes, more than the audit writes; not read`);
      return [];
    }
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      this.#deps.log(`failed to read the MCP audit file ${path}: ${messageOf(err)}`);
      return [];
    }
    return text.split("\n").flatMap((line) => {
      const parsed = McpCall.safeParse(parseJson(line));
      return parsed.success ? [bounded(parsed.data)] : [];
    });
  }
}

/** The call with every argument value and the error text cut to their limits. */
function bounded(call: McpCall): McpCall {
  const args = call.args && Object.fromEntries(Object.entries(call.args).map(([key, value]) => [key, boundedValue(value)]));
  const outcome =
    call.outcome.kind === "ok" ? call.outcome : { ...call.outcome, message: cut(call.outcome.message, MCP_AUDIT_MAX_ERROR_CHARS) };
  return { ...call, args, outcome };
}

/** A value whose JSON is longer than the limit becomes the start of that JSON, so a long array or string cannot fill the file. */
function boundedValue(value: unknown): unknown {
  if (value === undefined) return value;
  const json = JSON.stringify(value);
  return json.length <= MCP_AUDIT_MAX_ARG_CHARS ? value : cut(json, MCP_AUDIT_MAX_ARG_CHARS);
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
