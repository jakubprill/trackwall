import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type UsageReport as Report,
  USAGE_REPORT_DAYS,
  USAGE_REPORT_MAX_WEEKS_AGO,
  type UsageTool,
  type UsageTrend,
  type UsageWeekTotal,
  type UsageWork,
} from "@trackwall/protocol";
import { conversationsDir, EVENT_LOG_FILE } from "../../infra/copilot-home.ts";
import { addReceipt, addTotals, firstSighting, NO_USAGE, type UsageTotals, usageOf } from "../../infra/copilot-usage-receipt.ts";
import { messageOf } from "../../infra/errors.ts";
import { type EventLogDigest, EventLogDigests, type LoggedToolCall } from "./event-log.ts";
import { type KnownPlaces, recordedPlace, type WorkPlace, withRealPaths, workPlace } from "./work-place.ts";

/**
 * The `usage-report` module (ADR-199, §4.25): what Copilot CLI used in one week on this computer, by the work it was
 * for and by tool, so the user sees where tokens go, and the totals of every week side by side (ADR-236). It reads
 * the event logs Copilot CLI keeps for every conversation in its home (`event-log.ts`), only when a report is asked
 * for, and ties each conversation to its work by the folder and branch Copilot CLI recorded (`work-place.ts`). Every
 * conversation on the computer counts, also those Trackwall did not start; nothing is kept on disk, and nothing
 * leaves the computer.
 */

const WEEK_MS = USAGE_REPORT_DAYS * 24 * 60 * 60 * 1000;

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
    const sums = new WeekSums(weekWindow(this.#deps.now(), weeksAgo));
    const places = await withRealPaths(await this.#deps.places());
    const unreadLogs = await this.#eachLog(sums.window.from, (digest, conversation) =>
      sums.add(digest, async () => workPlace(await recordedPlace(conversation), places)),
    );
    return sums.report(unreadLogs);
  }

  /** The totals of the current week and the `USAGE_REPORT_MAX_WEEKS_AGO` weeks before it, the oldest first. */
  async trend(): Promise<UsageTrend> {
    const now = this.#deps.now();
    const weeks = new TrendSums(now);
    const unreadLogs = await this.#eachLog(weeks.from, async (digest) => weeks.add(digest));
    return { weeks: weeks.weeks(), unreadLogs };
  }

  /**
   * Hands every conversation's digest with a log written since `since` (ms) to `use`, with the conversation's folder,
   * and returns how many logs could not be read.
   */
  async #eachLog(since: number, use: (digest: EventLogDigest, conversation: string) => Promise<void>): Promise<number> {
    const dir = conversationsDir(await this.#deps.copilotHome());
    const logs = new Set<string>();
    let unreadLogs = 0;
    for (const conversation of await conversationDirs(dir)) {
      const file = join(dir, conversation, EVENT_LOG_FILE);
      logs.add(file);
      const digest = await this.#digests.of(file, since).catch((err: unknown) => {
        this.#deps.log(`usage report: reading ${file}: ${messageOf(err)}`);
        unreadLogs++;
        return undefined;
      });
      if (digest !== undefined) await use(digest, join(dir, conversation));
    }
    this.#digests.keepOnly(logs);
    return unreadLogs;
  }
}

/** A week counted back from `now`: `[now − 7·(weeksAgo+1) days, now − 7·weeksAgo days)`, its end not part of it. */
interface WeekWindow {
  weeksAgo: number;
  from: number;
  to: number;
}

function weekWindow(now: number, weeksAgo: number): WeekWindow {
  const to = now - weeksAgo * WEEK_MS;
  return { weeksAgo, from: to - WEEK_MS, to };
}

/** Whether a call at `at` (ISO 8601) is in the week; a call without a time is in none. */
function inWeek(window: WeekWindow, at: string | undefined): boolean {
  const time = at === undefined ? Number.NaN : Date.parse(at);
  return time >= window.from && time < window.to;
}

/**
 * What the trend adds up: every receipt in the week it falls in, the same windows `week` reads, so a week of the
 * trend and that week's report give the same total.
 */
class TrendSums {
  /** The current week first. */
  readonly #windows: WeekWindow[];
  readonly #totals: UsageTotals[];
  /** One set per week, as each `week` keeps its own: a receipt written again in another week counts in both, as there. */
  readonly #seenReceipts: Set<string>[];

  constructor(now: number) {
    this.#windows = Array.from({ length: USAGE_REPORT_MAX_WEEKS_AGO + 1 }, (_, weeksAgo) => weekWindow(now, weeksAgo));
    this.#totals = this.#windows.map(() => NO_USAGE);
    this.#seenReceipts = this.#windows.map(() => new Set<string>());
  }

  /** The start of the oldest week. */
  get from(): number {
    return Math.min(...this.#windows.map((w) => w.from));
  }

  add(digest: EventLogDigest): void {
    for (const receipt of digest.receipts) {
      const week = this.#windows.findIndex((w) => inWeek(w, receipt.at));
      const totals = this.#totals[week];
      const seen = this.#seenReceipts[week];
      if (totals === undefined || seen === undefined || !firstSighting(seen, receipt)) continue;
      this.#totals[week] = addReceipt(totals, receipt);
    }
  }

  /** The oldest first. */
  weeks(): UsageWeekTotal[] {
    return this.#windows
      .map((w, i) => {
        const totals = this.#totals[i] ?? NO_USAGE;
        return {
          from: new Date(w.from).toISOString(),
          to: new Date(w.to).toISOString(),
          weeksAgo: w.weeksAgo,
          total: usageOf(totals),
          toolDefinitionTokens: totals.toolDefinitionTokens,
        };
      })
      .reverse();
  }
}

/** What one report adds up, conversation by conversation, in one week. */
class WeekSums {
  readonly window: WeekWindow;
  readonly #work = new Map<string, WorkSums>();
  readonly #tools = new Map<string, UsageTool>();
  /** A receipt Copilot CLI wrote again (a resumed or forked conversation) counts once. */
  readonly #seenReceipts = new Set<string>();

  constructor(window: WeekWindow) {
    this.window = window;
  }

  /** A conversation's model and tool calls of the week; its place is read only when it has model calls in the week. */
  async add(digest: EventLogDigest, place: () => Promise<WorkPlace>): Promise<void> {
    for (const call of digest.toolCalls) if (inWeek(this.window, call.at)) addToolCall(this.#tools, call);
    const receipts = digest.receipts.filter((r) => inWeek(this.window, r.at) && firstSighting(this.#seenReceipts, r));
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
      from: new Date(this.window.from).toISOString(),
      to: new Date(this.window.to).toISOString(),
      total: usageOf(total),
      toolDefinitionTokens: total.toolDefinitionTokens,
      work: work.flatMap(workRow).sort((a, b) => b.usage.inputTokens - a.usage.inputTokens),
      tools: [...this.#tools.values()].sort((a, b) => b.resultTokens - a.resultTokens || b.calls - a.calls),
      unreadLogs,
    };
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
