import { describe, expect, test } from "bun:test";
import type { UsageWeekTotal } from "@trackwall/protocol";
import { showsLabel, trendChart, trendScale } from "../src/lib/usage-trend";

const week = (weeksAgo: number, inputTokens: number | null, toolDefinitionTokens = 0): UsageWeekTotal => ({
  from: new Date(Date.UTC(2026, 10, 1 - 7 * weeksAgo, 12)).toISOString(),
  to: new Date(Date.UTC(2026, 10, 8 - 7 * weeksAgo, 12)).toISOString(),
  weeksAgo,
  total:
    inputTokens === null
      ? null
      : { modelCalls: 1, inputTokens, outputTokens: 1, aiCredits: null, aiCreditsPartial: false, premiumRequests: 0 },
  toolDefinitionTokens,
});

describe("the usage trend in Settings › Usage (ADR-236)", () => {
  test("the scale steps by 1, 2, 4 or 5 times a power of ten and its top reaches the highest week", () => {
    expect(trendScale(10_200_000)).toEqual({ top: 12_000_000, ticks: [0, 4_000_000, 8_000_000, 12_000_000] });
    expect(trendScale(3_000)).toEqual({ top: 3_000, ticks: [0, 1_000, 2_000, 3_000] });
    expect(trendScale(740)).toEqual({ top: 800, ticks: [0, 400, 800] });
    expect(trendScale(0)).toEqual({ top: 1, ticks: [0, 1] });
    expect(trendScale(1)).toEqual({ top: 1, ticks: [0, 1] });
  });

  test("a week's bar splits its input tokens into tool definitions and the rest, on the scale", () => {
    const { ticks, bars } = trendChart([week(1, 10_200_000, 0), week(0, 6_000_000, 2_000_000)], "en-US");
    const bar = bars[1];

    expect(ticks).toEqual([
      { value: 0, percent: 0 },
      { value: 4_000_000, percent: (4 / 12) * 100 },
      { value: 8_000_000, percent: (8 / 12) * 100 },
      { value: 12_000_000, percent: 100 },
    ]);
    expect(bar).toMatchObject({ weeksAgo: 0, label: "Nov 8", restPercent: (4 / 12) * 100, definitionsPercent: (2 / 12) * 100 });
    expect(bar?.title).toBe("Nov 1 – Nov 8: 6M tokens in, 33% tool definitions");
  });

  test("a week without model calls has an empty bar that says so", () => {
    const [bar] = trendChart([week(3, null)], "en-US").bars;

    expect(bar).toMatchObject({ restPercent: 0, definitionsPercent: 0, title: "Oct 11 – Oct 18: no model calls" });
  });

  test("the picked week and every fourth week have their date, but not one next to the picked week", () => {
    const labelled = (picked: number) => [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0].filter((w) => showsLabel(w, picked));

    expect(labelled(0)).toEqual([12, 8, 4, 0]);
    expect(labelled(5)).toEqual([12, 8, 5, 0]);
    expect(labelled(1)).toEqual([12, 8, 4, 1]);
  });
});
