import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { z } from "zod";
import { type UsageReceipt, usageReceipt } from "../../infra/copilot-usage-receipt.ts";

/**
 * What the weekly usage report (ADR-195) takes from one conversation's event log, `events.jsonl` in Copilot CLI's
 * home: every model call's receipt (`infra/copilot-usage-receipt.ts`) and every tool call with the tokens its result
 * took (`tool.execution_start` and `tool.execution_complete`, joined by the call's id). The format is Copilot CLI's own
 * and undocumented; a contract test pins the fields read here, and a line of another shape is skipped. Nothing of a
 * prompt, an argument or a result leaves this file: only names, times and counts.
 */

/** One tool call as the event log reports it. */
export interface LoggedToolCall {
  /** When the call started, ISO 8601. */
  at: string;
  tool: string;
  /** The MCP server; `null` for a built-in tool. */
  server: string | null;
  failed: boolean;
  resultTokens: number;
}

export interface EventLogDigest {
  receipts: UsageReceipt[];
  toolCalls: LoggedToolCall[];
}

const TOOL_START = "tool.execution_start";
const TOOL_COMPLETE = "tool.execution_complete";

const ToolStart = z.object({
  type: z.literal(TOOL_START),
  timestamp: z.string(),
  data: z.object({
    toolCallId: z.string(),
    /** As the model sees it: `<server>-<tool>` for an MCP tool (1.0.103). */
    toolName: z.string(),
    mcpServerName: z.string().optional(),
    mcpToolName: z.string().optional(),
  }),
});

const ToolComplete = z.object({
  type: z.literal(TOOL_COMPLETE),
  data: z.object({
    toolCallId: z.string(),
    success: z.boolean(),
    toolTelemetry: z.object({ metrics: z.object({ result_token_count: z.number().nonnegative().optional() }).optional() }).optional(),
  }),
});

/** Reads a log line by line; `digest` gives what it found so far. */
export class EventLogReader {
  readonly #receipts: UsageReceipt[] = [];
  /** Calls by their id, in the order they started; a call without its end (still running, or cut off) counts too. */
  readonly #calls = new Map<string, LoggedToolCall>();

  line(line: string): void {
    const receipt = usageReceipt(line);
    if (receipt !== undefined) {
      this.#receipts.push(receipt);
      return;
    }
    if (line.includes(TOOL_START)) this.#start(line);
    else if (line.includes(TOOL_COMPLETE)) this.#complete(line);
  }

  digest(): EventLogDigest {
    return { receipts: [...this.#receipts], toolCalls: [...this.#calls.values()] };
  }

  #start(line: string): void {
    const parsed = ToolStart.safeParse(parseJson(line));
    if (!parsed.success) return;
    const { toolCallId, toolName, mcpServerName, mcpToolName } = parsed.data.data;
    const server = mcpServerName ?? null;
    const tool = server === null ? toolName : (mcpToolName ?? toolName);
    this.#calls.set(toolCallId, { at: parsed.data.timestamp, tool, server, failed: false, resultTokens: 0 });
  }

  #complete(line: string): void {
    const parsed = ToolComplete.safeParse(parseJson(line));
    if (!parsed.success) return;
    const { toolCallId, success, toolTelemetry } = parsed.data.data;
    const call = this.#calls.get(toolCallId);
    if (call === undefined) return;
    call.failed = !success;
    call.resultTokens = toolTelemetry?.metrics?.result_token_count ?? 0;
  }
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** A log's digest with the size and time it had when read, so an unchanged log is not read again. */
interface CachedDigest {
  size: number;
  mtimeMs: number;
  digest: EventLogDigest;
}

/**
 * Digests of event logs, kept while their files stay the same size and time: a report reads the week's logs again,
 * and most of them have not changed since the last report. A log is read as a stream, since tool results make it long.
 */
export class EventLogDigests {
  readonly #cache = new Map<string, CachedDigest>();

  /** The digest of the log of `size` and `mtimeMs`, as the caller found them; throws when the file cannot be read. */
  async of(file: string, size: number, mtimeMs: number): Promise<EventLogDigest> {
    const cached = this.#cache.get(file);
    if (cached !== undefined && cached.size === size && cached.mtimeMs === mtimeMs) return cached.digest;
    const reader = new EventLogReader();
    const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Number.POSITIVE_INFINITY });
    for await (const line of lines) reader.line(line);
    const digest = reader.digest();
    // Kept under the size and time from before the read: a log that grew while it was read is read again next time.
    this.#cache.set(file, { size, mtimeMs, digest });
    return digest;
  }

  /** Forgets the logs not in `files`, the logs there are now, so the cache does not keep conversations Copilot CLI removed. */
  keepOnly(files: ReadonlySet<string>): void {
    for (const file of this.#cache.keys()) if (!files.has(file)) this.#cache.delete(file);
  }
}
