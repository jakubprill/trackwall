import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { type UsageReport as Report, USAGE_REPORT_DAYS, type UsageTool, type UsageWork } from "@trackwall/protocol";
import { conversationsDir, EVENT_LOG_FILE } from "../../infra/copilot-home.ts";
import { addReceipt, addTotals, firstSighting, NO_USAGE, type UsageTotals, usageOf } from "../../infra/copilot-usage-receipt.ts";
import { messageOf } from "../../infra/errors.ts";
import { type EventLogDigest, EventLogDigests, type LoggedToolCall } from "./event-log.ts";
import { type KnownPlaces, recordedPlace, type WorkPlace, withRealPaths, workPlace } from "./work-place.ts";

/**
 * The `usage-report` module (ADR-195, §4.25): what Copilot CLI used in one week on this computer, by the work it was
 * for and by tool, so the user sees where tokens go. It reads the event logs Copilot CLI keeps for every conversation
 * in its home (`event-log.ts`), only when the report is asked for, and ties each conversation to its work by the folder
 * and branch Copilot CLI recorded (`work-place.ts`). Every conversation on the computer counts, also those Trackwall
 * did not start; nothing is kept on disk, and nothing leaves the computer.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface UsageReportDeps {
  /** Copilot CLI's home in the user's environment. */
  copilotHome: () => Promise<string>;
  /** The tasks, running and ended, the repos and the projects folder, at the time of the report. */
  places: () => Promise<KnownPlaces>;
  now: () => number;
  log: (msg: string) => void;
}

/** A work's running sums in the report. */
interface WorkSums {
  place: WorkPlace;
  conversations: number;
  totals: UsageTotals;
}

export class UsageReport {
  readonly #deps: UsageReportDeps;
  readonly #digests = new EventLogDigests();

  constructor(deps: UsageReportDeps) {
    this.#deps = deps;
  }

  /** The `USAGE_REPORT_DAYS` days that ended `weeksAgo` weeks before now. */
  async week(weeksAgo: number): Promise<Report> {
    const to = this.#deps.now() - weeksAgo * USAGE_REPORT_DAYS * DAY_MS;
    const sums = new WeekSums(to - USAGE_REPORT_DAYS * DAY_MS, to);
    const dir = conversationsDir(await this.#deps.copilotHome());
    const places = await withRealPaths(await this.#deps.places());
    const logs = new Set<string>();
    let unreadLogs = 0;
    for (const conversation of await conversationDirs(dir)) {
      const file = join(dir, conversation, EVENT_LOG_FILE);
      const found = await fileState(file);
      if (found === undefined) continue;
      logs.add(file);
      // A log last written before the week has nothing in it.
      if (found.mtimeMs < sums.from) continue;
      const digest = await this.#digests.of(file, found.size, found.mtimeMs).catch((err: unknown) => {
        this.#deps.log(`usage report: reading ${file}: ${messageOf(err)}`);
        return undefined;
      });
      if (digest === undefined) unreadLogs++;
      else await sums.add(digest, async () => workPlace(await recordedPlace(join(dir, conversation)), places));
    }
    this.#digests.keepOnly(logs);
    return sums.report(unreadLogs);
  }
}

/** What one report adds up, conversation by conversation, in the week from `from` up to `to` (both in ms). */
class WeekSums {
  readonly from: number;
  readonly to: number;
  readonly #work = new Map<string, WorkSums>();
  readonly #tools = new Map<string, UsageTool>();
  /** A receipt Copilot CLI wrote again (a resumed or forked conversation) counts once. */
  readonly #seenReceipts = new Set<string>();

  constructor(from: number, to: number) {
    this.from = from;
    this.to = to;
  }

  /** A conversation's model and tool calls of the week; its place is read only when it has model calls in the week. */
  async add(digest: EventLogDigest, place: () => Promise<WorkPlace>): Promise<void> {
    for (const call of digest.toolCalls) if (this.#inWeek(call.at)) addToolCall(this.#tools, call);
    const receipts = digest.receipts.filter((r) => this.#inWeek(r.at) && firstSighting(this.#seenReceipts, r));
    if (receipts.length === 0) return;
    const at = await place();
    const key = JSON.stringify([at.kind, at.task, at.repo, at.label]);
    const sums = this.#work.get(key) ?? { place: at, conversations: 0, totals: NO_USAGE };
    this.#work.set(key, { place: at, conversations: sums.conversations + 1, totals: receipts.reduce(addReceipt, sums.totals) });
  }

  report(unreadLogs: number): Report {
    const work = [...this.#work.values()];
    const total = work.reduce((all, w) => addTotals(all, w.totals), NO_USAGE);
    return {
      from: new Date(this.from).toISOString(),
      to: new Date(this.to).toISOString(),
      total: usageOf(total),
      toolDefinitionTokens: total.toolDefinitionTokens,
      work: work.flatMap(workRow).sort((a, b) => b.usage.inputTokens - a.usage.inputTokens),
      tools: [...this.#tools.values()].sort((a, b) => b.resultTokens - a.resultTokens || b.calls - a.calls),
      unreadLogs,
    };
  }

  #inWeek(at: string | undefined): boolean {
    const time = at === undefined ? Number.NaN : Date.parse(at);
    return time >= this.from && time < this.to;
  }
}

/** The conversation folders in Copilot CLI's home; none before its first conversation. */
async function conversationDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    // Sorted, so a receipt two logs share counts in the same log on every system, whatever order its file system lists.
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** A log's size and time; `undefined` for a conversation without one as a regular file. */
async function fileState(file: string): Promise<{ size: number; mtimeMs: number } | undefined> {
  try {
    // Not through a link and never a FIFO an agent could plant there, which would hold the report's read forever.
    const found = await lstat(file);
    return found.isFile() ? { size: found.size, mtimeMs: found.mtimeMs } : undefined;
  } catch {
    return undefined;
  }
}

function addToolCall(tools: Map<string, UsageTool>, call: LoggedToolCall): void {
  const key = JSON.stringify([call.server, call.tool]);
  const sums = tools.get(key) ?? { tool: call.tool, server: call.server, calls: 0, failures: 0, resultTokens: 0 };
  tools.set(key, {
    ...sums,
    calls: sums.calls + 1,
    failures: sums.failures + (call.failed ? 1 : 0),
    resultTokens: sums.resultTokens + call.resultTokens,
  });
}

function workRow({ place, conversations, totals }: WorkSums): UsageWork[] {
  const usage = usageOf(totals);
  if (usage === null) return [];
  return [{ ...place, conversations, usage, toolDefinitionTokens: totals.toolDefinitionTokens }];
}
