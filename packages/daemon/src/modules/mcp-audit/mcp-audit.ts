import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MCP_AUDIT_MAX_ARG_CHARS, MCP_AUDIT_MAX_CALLS, MCP_AUDIT_MAX_ERROR_CHARS, McpCall, type McpCallList } from "@trackwall/protocol";
import { messageOf } from "../../infra/errors.ts";
import { RotatingJsonlFile, rotatedPath } from "../../infra/rotating-jsonl-file.ts";

/**
 * The `mcp-audit` module (ADR-152): every MCP tool call the daemon answered, so the person can see what agents did
 * through Trackwall, also after a restart. A call is one JSON line appended to `logs/mcp-calls.jsonl` in the state
 * directory as it ends; at `MAX_FILE_BYTES` the file becomes `mcp-calls.1.jsonl` and a new one starts, so the audit
 * takes at most twice that on disk. The last `MCP_AUDIT_MAX_CALLS` calls stay in memory, read back from both files at
 * the start. Only what the tool's contract names as identifier arguments comes in (`auditArgs`), and every value and
 * error text is cut here, whatever the caller passes. Nothing leaves the computer, and no MCP tool reads it: the audit
 * is for the person, not for an agent to learn what other agents did.
 */

const FILE = "mcp-calls.jsonl";
/** About 3000 calls of a few hundred bytes: far more than the calls kept in memory, so a rotation never loses those. */
const MAX_FILE_BYTES = 1024 * 1024;
/**
 * A file larger than this was not written by the audit, or grew while its rotation kept failing (a file held open on
 * Windows): it is not read at the start, so the daemon does not read a huge file into memory.
 */
const MAX_READ_BYTES = 4 * MAX_FILE_BYTES;

export interface McpAuditDeps {
  /** The state directory's `logs/`. */
  dir: string;
  log: (msg: string) => void;
}

export class McpAudit {
  readonly #deps: McpAuditDeps;
  readonly #file: RotatingJsonlFile;
  readonly #calls: McpCall[];
  #revision = 0;

  constructor(deps: McpAuditDeps) {
    this.#deps = deps;
    const path = join(deps.dir, FILE);
    this.#file = new RotatingJsonlFile(path, MAX_FILE_BYTES, (err) =>
      deps.log(`failed to rotate the MCP audit, the file grows until it can: ${messageOf(err)}`),
    );
    this.#calls = [...this.#read(rotatedPath(path)), ...this.#read(path)].slice(-MCP_AUDIT_MAX_CALLS);
  }

  /**
   * Never throws: it runs on the path that answers the agent, which a full disk must not break. A line that could not
   * be written stays in the file's buffer for the next call.
   */
  record(call: McpCall): void {
    const kept = bounded(call);
    this.#calls.push(kept);
    if (this.#calls.length > MCP_AUDIT_MAX_CALLS) this.#calls.shift();
    this.#revision++;
    if (!this.#file.append(JSON.stringify(kept)))
      this.#deps.log("the MCP audit cannot write and its buffer is full; a call was not written");
    try {
      this.#file.flush();
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

  /** The calls of one file; a line that is not a call (cut by a crash mid-write, edited by hand) is skipped. */
  #read(path: string): McpCall[] {
    let text: string;
    try {
      const size = statSync(path).size;
      if (size > MAX_READ_BYTES) {
        this.#deps.log(`the MCP audit file ${path} has ${size} bytes, more than the audit writes; not read`);
        return [];
      }
      text = readFileSync(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") this.#deps.log(`failed to read the MCP audit file ${path}: ${messageOf(err)}`);
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
  const args = Object.fromEntries(Object.entries(call.args).map(([key, value]) => [key, boundedValue(value)]));
  const outcome =
    call.outcome.kind === "ok" ? call.outcome : { ...call.outcome, message: cut(call.outcome.message, MCP_AUDIT_MAX_ERROR_CHARS) };
  return { ...call, args, outcome };
}

/** A value whose JSON is longer than the limit becomes the start of that JSON, so a long array or string cannot fill the file. */
function boundedValue(value: unknown): unknown {
  const json = JSON.stringify(value);
  return json === undefined || json.length <= MCP_AUDIT_MAX_ARG_CHARS ? value : cut(json, MCP_AUDIT_MAX_ARG_CHARS);
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
