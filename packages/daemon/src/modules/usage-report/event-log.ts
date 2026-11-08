import { createInterface } from "node:readline";
import { z } from "zod";
import { type UsageReceipt, usageReceipt } from "../../infra/copilot-usage-receipt.ts";
import { NotRegularFileError, openRegularFile } from "../../infra/regular-file.ts";

/**
 * What the weekly usage report (ADR-199) takes from one conversation's event log, `events.jsonl` in Copilot CLI's
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

/** Far more than a long conversation's log; a larger file is not Copilot CLI's log, or not one worth a report's wait. */
const MAX_LOG_BYTES = 2 * 1024 ** 3;

/**
 * Digests of event logs, kept while their files stay the same size and time: a report reads the week's logs again,
 * and most of them have not changed since the last report. A log is opened as a regular file only
 * (`infra/regular-file.ts`): an agent can write into Copilot CLI's home, and a link or a FIFO in a log's place must not
 * hold the report. It is read as a stream from that same handle, since tool results make it long.
 */
export class EventLogDigests {
  readonly #cache = new Map<string, CachedDigest>();
  /** Reads under way, by file. */
  readonly #reading = new Map<string, Promise<EventLogDigest | undefined>>();

  /**
   * The log's digest; `undefined` when there is no log, it is not a regular file, or it was last written before
   * `writtenSince` (it has nothing newer). Throws when the file cannot be read.
   */
  async of(file: string, writtenSince: number): Promise<EventLogDigest | undefined> {
    // The week and the trend are asked for together: the second waits for the first's read and finds it cached,
    // instead of streaming a long log twice.
    for (let pending = this.#reading.get(file); pending !== undefined; pending = this.#reading.get(file))
      await pending.catch(() => undefined);
    const read = this.#read(file, writtenSince);
    this.#reading.set(file, read);
    try {
      return await read;
    } finally {
      if (this.#reading.get(file) === read) this.#reading.delete(file);
    }
  }

  async #read(file: string, writtenSince: number): Promise<EventLogDigest | undefined> {
    const opened = await openRegularFile(file, MAX_LOG_BYTES).catch((err: unknown) => {
      if (err instanceof NotRegularFileError) return undefined;
      throw err;
    });
    if (opened === undefined) return undefined;
    const { handle } = opened;
    const { size, mtimeMs } = await handle.stat().catch(async (err: unknown) => {
      await handle.close();
      throw err;
    });
    const cached = this.#cache.get(file);
    if (mtimeMs < writtenSince || (cached !== undefined && cached.size === size && cached.mtimeMs === mtimeMs)) {
      await handle.close();
      return mtimeMs < writtenSince ? undefined : cached?.digest;
    }
    const reader = new EventLogReader();
    // The stream closes the handle when it ends or fails.
    const input = handle.createReadStream({ encoding: "utf8" });
    for await (const line of createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })) reader.line(line);
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
