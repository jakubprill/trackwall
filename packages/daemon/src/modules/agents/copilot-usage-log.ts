import { closeSync, openSync, readSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { COPILOT_AUTO_MODEL, type CopilotUsage, type ModelCalls } from "@trackwall/protocol";
import { conversationEventLog } from "../../infra/copilot-home.ts";
import { addReceipt, firstSighting, NO_USAGE, type UsageTotals, usageOf, usageReceipt } from "../../infra/copilot-usage-receipt.ts";
import { modelChangeOf } from "./copilot-model-change.ts";

/**
 * What a session's conversation used (ADR-190, §4.4), from the conversation's event log that Copilot CLI keeps in its
 * home: `session-state/<conversation>/events.jsonl`. After every model call Copilot CLI appends a durable receipt,
 * `session.usage_record` (`infra/copilot-usage-receipt.ts`), with the call's tokens, its model multiplier and, on token
 * billing, its cost in nano AI units (10⁹ of them make one AI credit, as Copilot CLI's `/usage` converts them). A
 * contract test pins where and when the receipt is written. The same log names the model the conversation runs on
 * (ADR-225): each receipt the model of its call, and `session.model_change` the model set at a start, a resume or by
 * `/model`, so a model Copilot CLI took instead of the requested one shows. The log is read on demand only (`update`),
 * from where the last read stopped, so a long conversation is read once and every later turn costs only its new lines.
 */

/** What the log says so far: the usage sums, the model in use and the own calls on each model. */
interface LogState {
  totals: UsageTotals;
  /**
   * The latest own receipt's model or model change's model, in the log's order; `null` before either, and after a change
   * to `auto` until the next own receipt.
   */
  modelInUse: string | null;
  /** The conversation's own model calls by the model their receipt names (ADR-228). */
  callsByModel: Readonly<Record<string, number>>;
}

const NOTHING_READ: LogState = { totals: NO_USAGE, modelInUse: null, callsByModel: {} };

/**
 * One line of the log added to what it says; `seen` keeps receipts counted once. A receipt written again (a resumed
 * conversation) counts no usage and names no model, since the model change of the resume comes before it.
 */
function add(state: LogState, line: string, seen: Set<string>): LogState {
  const receipt = usageReceipt(line);
  if (receipt === undefined) {
    const changed = modelChangeOf(line);
    if (changed === undefined) return state;
    // A change to `auto` (a start whose model the account lacks, or `/model auto`) names no model: Copilot CLI picks one
    // per call, and the next own receipt says which. Until then the model in use is unknown, not `auto`.
    return { ...state, modelInUse: changed === COPILOT_AUTO_MODEL ? null : changed };
  }
  if (!firstSighting(seen, receipt)) return state;
  // A receipt without an identity (older Copilot CLI) cannot be told from one a resume writes again, so it names no model.
  const model = receipt.key === undefined ? undefined : receipt.ownModel;
  const totals = addReceipt(state.totals, receipt);
  if (model === undefined) return { ...state, totals };
  return { totals, modelInUse: model, callsByModel: { ...state.callsByModel, [model]: (state.callsByModel[model] ?? 0) + 1 } };
}

/** The own calls on each model, the most first, then by name, so the same log always gives the same list. */
function modelCallsOf(state: LogState): ModelCalls[] {
  return Object.entries(state.callsByModel)
    .map(([model, modelCalls]) => ({ model, modelCalls }))
    .sort((a, b) => b.modelCalls - a.modelCalls || a.model.localeCompare(b.model));
}

/** What whole lines of a log say, for a reader that has the log in memory (the tests, a script). */
function stateOfLines(lines: readonly string[]): LogState {
  const seen = new Set<string>();
  return lines.reduce((state, line) => add(state, line, seen), NOTHING_READ);
}

/** The usage sums of whole receipt lines. */
export function usageOfLines(lines: readonly string[]): CopilotUsage | null {
  return usageOf(stateOfLines(lines).totals);
}

/** The model in use after whole lines of a log (ADR-225). */
export function modelInUseOfLines(lines: readonly string[]): string | null {
  return stateOfLines(lines).modelInUse;
}

/** The own model calls on each model after whole lines of a log (ADR-228). */
export function modelCallsOfLines(lines: readonly string[]): ModelCalls[] {
  return modelCallsOf(stateOfLines(lines));
}

/** What a whole conversation used and on which models, for the record of a task as it ends (ADR-228). */
export interface ConversationUse {
  usage: CopilotUsage | null;
  models: ModelCalls[];
}

/** A conversation that used nothing, or whose log is unknown. */
export const NO_CONVERSATION_USE: ConversationUse = { usage: null, models: [] };

/**
 * Reads a conversation's whole event log once: when a task ends its sessions have stopped, so the log is complete. A
 * log that is missing or cannot be read is no usage and no model.
 */
export function readConversationUse(copilotHome: string, conversation: string): ConversationUse {
  const log = new CopilotUsageLog(copilotHome);
  log.update(conversation);
  return { usage: log.current(), models: log.modelCalls() };
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
  #state: LogState = NOTHING_READ;
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
    return usageOf(this.#state.totals);
  }

  /** The model the conversation runs on after the last update (ADR-225); `null` before the log names one. */
  modelInUse(): string | null {
    return this.#state.modelInUse;
  }

  /** The conversation's own model calls on each model after the last update (ADR-228), the most first. */
  modelCalls(): ModelCalls[] {
    return modelCallsOf(this.#state);
  }

  /**
   * Reads what a conversation this session goes on with used before its start, and forgets the model in use the log
   * named then: a restart on another model would otherwise show the old one until Copilot CLI writes the start's model
   * change, and warn about a switch that is not there (ADR-225).
   */
  readBeforeStart(conversation: string): void {
    this.update(conversation);
    this.#state = { ...this.#state, modelInUse: null };
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
      for (const line of lines) this.#state = add(this.#state, line, this.#seen);
    }
  }

  #restart(file: string): void {
    this.#file = file;
    this.#offset = 0;
    this.#rest = "";
    this.#decoder = new StringDecoder("utf8");
    this.#state = NOTHING_READ;
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
