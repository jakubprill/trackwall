import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { CopilotUsage } from "@trackwall/protocol";
import { z } from "zod";

/**
 * What a session's conversation used (ADR-190, §4.4), from the conversation's event log that Copilot CLI keeps in its
 * home: `session-state/<conversation>/events.jsonl`. After every model call Copilot CLI appends a durable receipt,
 * `session.usage_record`, with the call's tokens, its model multiplier and, on token billing, its cost in nano AI
 * units (10⁹ of them make one AI credit, as Copilot CLI's `/usage` converts them). The format is Copilot CLI's own and
 * undocumented; a contract test pins where and when the receipt is written and the fields read here, and anything else
 * in a line is ignored. The log is read on demand only (`update`), from where the last read stopped, so a long
 * conversation is read once and every later turn costs only its new lines.
 */

/** The receipt's type; a line without this text is not parsed at all, since tool results can make lines long. */
const USAGE_RECORD = "session.usage_record";

const NANO_AIU_PER_AI_CREDIT = 1e9;

const UsageRecord = z.object({
  type: z.literal(USAGE_RECORD),
  data: z.object({
    usage: z.object({
      inputTokens: z.number().int().nonnegative().default(0),
      outputTokens: z.number().int().nonnegative().default(0),
      /** The model multiplier of the call (premium requests of the legacy billing). */
      cost: z.number().nonnegative().default(0),
      /** What started the call; absent or `user` for the user's own turn, `sub-agent` and others for the rest. */
      initiator: z.string().optional(),
      aiCreditsStatus: z.enum(["complete", "partial", "unavailable"]).optional(),
      copilotUsage: z.object({ totalNanoAiu: z.number().nonnegative().optional() }).optional(),
      /** Copilot CLI's own identity of the receipt, the same when a resumed conversation writes it again. */
      accounting: z.object({ sourceSessionId: z.string(), sequence: z.number().int() }).optional(),
    }),
  }),
});

/** The running sums of one event log. */
interface Totals {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  nanoAiu: number;
  callsWithCredits: number;
  callsWithoutCredits: number;
  premiumRequests: number;
}

const NO_TOTALS: Totals = {
  modelCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  nanoAiu: 0,
  callsWithCredits: 0,
  callsWithoutCredits: 0,
  premiumRequests: 0,
};

/** One receipt line added to the sums; `seen` keeps receipts counted once. */
function add(totals: Totals, line: string, seen: Set<string>): Totals {
  if (!line.includes(USAGE_RECORD)) return totals;
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return totals;
  }
  const parsed = UsageRecord.safeParse(json);
  if (!parsed.success) return totals;
  const usage = parsed.data.data.usage;
  if (usage.accounting !== undefined) {
    const key = `${usage.accounting.sourceSessionId}:${usage.accounting.sequence}`;
    if (seen.has(key)) return totals;
    seen.add(key);
  }
  const nanoAiu = usage.aiCreditsStatus === "unavailable" ? undefined : usage.copilotUsage?.totalNanoAiu;
  const own = usage.initiator === undefined || usage.initiator === "user";
  return {
    modelCalls: totals.modelCalls + 1,
    inputTokens: totals.inputTokens + usage.inputTokens,
    outputTokens: totals.outputTokens + usage.outputTokens,
    nanoAiu: totals.nanoAiu + (nanoAiu ?? 0),
    callsWithCredits: totals.callsWithCredits + (nanoAiu === undefined ? 0 : 1),
    callsWithoutCredits: totals.callsWithoutCredits + (nanoAiu === undefined || usage.aiCreditsStatus === "partial" ? 1 : 0),
    premiumRequests: totals.premiumRequests + (own ? usage.cost : 0),
  };
}

/** The sums as a session shows them; `null` before the first model call. */
function usageOf(totals: Totals): CopilotUsage | null {
  if (totals.modelCalls === 0) return null;
  return {
    modelCalls: totals.modelCalls,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    aiCredits: totals.callsWithCredits === 0 ? null : totals.nanoAiu / NANO_AIU_PER_AI_CREDIT,
    aiCreditsPartial: totals.callsWithCredits > 0 && totals.callsWithoutCredits > 0,
    premiumRequests: totals.premiumRequests,
  };
}

/** The sums of whole receipt lines, for a reader that has the log in memory (the tests, a script). */
export function usageOfLines(lines: readonly string[]): CopilotUsage | null {
  const seen = new Set<string>();
  return usageOf(lines.reduce((totals, line) => add(totals, line, seen), NO_TOTALS));
}

/** The event log of a conversation in Copilot CLI's home. */
export function conversationEventLog(copilotHome: string, conversation: string): string {
  return join(copilotHome, "session-state", conversation, "events.jsonl");
}

/** How often a running session's cycle looks at its event log: a size check, and a read only of what is new. */
const USAGE_READ_MS = 2000;

/** How much of the log one read takes at most; a longer rest waits for the next update. */
const READ_CHUNK = 4 * 1024 * 1024;

/**
 * The usage of one session's conversation. `update` reads what Copilot CLI appended since the last read: the session
 * calls it once at its start (a resumed conversation), every `USAGE_READ_MS` of its cycle while it runs (`poll`) and when
 * its process ends. `current` is free.
 */
export class CopilotUsageLog {
  readonly #copilotHome: string;
  #file: string | undefined;
  #offset = 0;
  #rest = "";
  /** Keeps a character split between two reads whole. */
  #decoder = new StringDecoder("utf8");
  #totals: Totals = NO_TOTALS;
  #seen = new Set<string>();
  #readAt = 0;

  constructor(copilotHome: string) {
    this.#copilotHome = copilotHome;
  }

  /**
   * `update` at most once per `USAGE_READ_MS`, for a session's cycle: Copilot CLI writes its event log in batches, so a
   * receipt can land after the hook that ends its turn, and only a later read finds it.
   */
  poll(conversation: string, now: number): void {
    if (now - this.#readAt < USAGE_READ_MS) return;
    this.#readAt = now;
    this.update(conversation);
  }

  /** The usage after the last update; `null` before the first model call. */
  current(): CopilotUsage | null {
    return usageOf(this.#totals);
  }

  /**
   * Reads the new receipts of `conversation`'s log (the session's id in a terminal, Copilot CLI's id over ACP). A log
   * that is missing or cannot be read leaves the sums as they are; one that got shorter is read again from its start.
   */
  update(conversation: string): void {
    const file = conversationEventLog(this.#copilotHome, conversation);
    if (file !== this.#file) this.#restart(file);
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return;
    }
    if (size < this.#offset) this.#restart(file);
    while (this.#offset < size) {
      const chunk = this.#read(file, Math.min(READ_CHUNK, size - this.#offset));
      if (chunk === undefined || chunk.length === 0) return;
      this.#offset += chunk.length;
      const lines = (this.#rest + this.#decoder.write(chunk)).split("\n");
      this.#rest = lines.pop() ?? "";
      for (const line of lines) this.#totals = add(this.#totals, line, this.#seen);
    }
  }

  #restart(file: string): void {
    this.#file = file;
    this.#offset = 0;
    this.#rest = "";
    this.#decoder = new StringDecoder("utf8");
    this.#totals = NO_TOTALS;
    this.#seen = new Set();
  }

  #read(file: string, length: number): Buffer | undefined {
    let fd: number | undefined;
    try {
      fd = openSync(file, "r");
      const buffer = Buffer.alloc(length);
      const read = readSync(fd, buffer, 0, length, this.#offset);
      return buffer.subarray(0, read);
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}
