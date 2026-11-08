import type { UsageWeekTotal } from "@trackwall/protocol";
import { tokenCount } from "./copilot-usage.ts";
import { toolDefinitionShare, weekLastDay, weekRange } from "./usage-report.ts";

/**
 * The usage trend above the weekly report in Settings › Usage (ADR-236): one bar per week, its input tokens split into
 * tool definitions and the rest, on a scale with round steps, so a change that should lower the use (fewer MCP tools,
 * another model) shows as a step down from the week it came in.
 */

/** One week's bar, heights in percent of the scale's top. */
interface TrendBar {
  weeksAgo: number;
  /** The week's last day, "Nov 8", under the bar. */
  label: string;
  /** Input tokens that were not tool definitions. */
  restPercent: number;
  definitionsPercent: number;
  /** What hovering the bar says: the dates, the tokens in and the share of definitions. */
  title: string;
}

/** A grid line: its value and its height in percent of the scale's top. */
interface TrendTick {
  value: number;
  percent: number;
}

interface TrendScale {
  /** The value at the top of the chart, a whole number of steps. */
  top: number;
  /** The grid lines from 0 up to `top`. */
  ticks: number[];
}

/** About this many steps fit the chart's height and stay readable. */
const STEPS = 3;

/** Every this many weeks a bar has its date under it, counted back from the current week. */
const LABEL_EVERY = 4;

/** A scale from 0 with round steps (1, 2, 4 or 5 times a power of ten, at least 1 token) whose top is at or above `max`. */
export function trendScale(max: number): TrendScale {
  if (max <= 0) return { top: 1, ticks: [0, 1] };
  const rough = max / STEPS;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = Math.max(1, [1, 2, 4, 5, 10].map((m) => m * power).find((s) => s >= rough) ?? 10 * power);
  const top = Math.ceil(max / step) * step;
  return { top, ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step) };
}

/** The chart of the weeks, the oldest first as the daemon gives them: its grid lines and its bars. */
export function trendChart(weeks: readonly UsageWeekTotal[], locale?: string): { ticks: TrendTick[]; bars: TrendBar[] } {
  const scale = trendScale(Math.max(0, ...weeks.map((w) => w.total?.inputTokens ?? 0)));
  const percent = (n: number) => (n / scale.top) * 100;
  return {
    ticks: scale.ticks.map((value) => ({ value, percent: percent(value) })),
    bars: weeks.map((week) => {
      const input = week.total?.inputTokens ?? 0;
      return {
        weeksAgo: week.weeksAgo,
        label: weekLastDay(week, locale),
        restPercent: percent(input - week.toolDefinitionTokens),
        definitionsPercent: percent(week.toolDefinitionTokens),
        title: barTitle(week, input, locale),
      };
    }),
  };
}

/**
 * Whether a bar's date shows under it: the picked week's always, and every `LABEL_EVERY`th week's unless it stands
 * next to the picked one, where the two dates would run into each other.
 */
export function showsLabel(weeksAgo: number, picked: number): boolean {
  if (weeksAgo === picked) return true;
  return weeksAgo % LABEL_EVERY === 0 && Math.abs(weeksAgo - picked) > 1;
}

function barTitle(week: UsageWeekTotal, input: number, locale: string | undefined): string {
  const range = weekRange(week, locale);
  if (week.total === null) return `${range}: no model calls`;
  const share = toolDefinitionShare(input, week.toolDefinitionTokens);
  const definitions = share === null || share === 0 ? "" : `, ${share}% tool definitions`;
  return `${range}: ${tokenCount(input)} tokens in${definitions}`;
}
