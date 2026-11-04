import { closeSync, openSync, readSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type { CopilotUsage } from "@trackwall/protocol";
import { conversationEventLog } from "../../infra/copilot-home.ts";
import { addReceipt, NO_USAGE, type UsageTotals, usageOf, usageReceipt } from "../../infra/copilot-usage-receipt.ts";

/**
 * What a session's conversation used (ADR-190, §4.4), from the conversation's event log that Copilot CLI keeps in its
 * home: `session-state/<conversation>/events.jsonl`. After every model call Copilot CLI appends a durable receipt,
 * `session.usage_record` (`infra/copilot-usage-receipt.ts`), with the call's tokens, its model multiplier and, on token
 * billing, its cost in nano AI units (10⁹ of them make one AI credit, as Copilot CLI's `/usage` converts them). A
 * contract test pins where and when the receipt is written. The log is read on demand only (`update`), from where the last read stopped, so a long
 * conversation is read once and every later turn costs only its new lines.
 */

/** One receipt line added to the sums; `seen` keeps receipts counted once. */
function add(totals: UsageTotals, line: string, seen: Set<string>): UsageTotals {
  const receipt = usageReceipt(line);
  if (receipt === undefined) return totals;
  if (receipt.key !== undefined) {
    if (seen.has(receipt.key)) return totals;
    seen.add(receipt.key);
  }
  return addReceipt(totals, receipt);
}

/** The sums of whole receipt lines, for a reader that has the log in memory (the tests, a script). */
export function usageOfLines(lines: readonly string[]): CopilotUsage | null {
  const seen = new Set<string>();
  return usageOf(lines.reduce((totals, line) => add(totals, line, seen), NO_USAGE));
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
  #totals: UsageTotals = NO_USAGE;
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
    this.#totals = NO_USAGE;
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
