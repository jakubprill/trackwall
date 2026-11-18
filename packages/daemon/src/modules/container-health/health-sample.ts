import type { HealthSample, OomKill } from "@trackwall/protocol";
import { z } from "zod";
import type { ControlGroupReading } from "./control-group.ts";

/**
 * One reading of the control group, as the sampler keeps it every 30 seconds for a day (ADR-279), and what the panel
 * makes of a run of them: processor shares between neighbours, kills for memory where the count rose, and one point per
 * five minutes for the chart. Readings are the kernel's running totals, so a share needs two of them.
 */

export const Reading = z.object({
  at: z.iso.datetime(),
  memoryBytes: z.number().nonnegative().nullable(),
  oomKills: z.number().int().nonnegative().nullable(),
  cpuUsageUsec: z.number().nonnegative().nullable(),
  periods: z.number().nonnegative().nullable(),
  throttledPeriods: z.number().nonnegative().nullable(),
});
export type Reading = z.infer<typeof Reading>;

export function readingOf(at: Date, group: ControlGroupReading): Reading {
  return {
    at: at.toISOString(),
    memoryBytes: group.memory?.current ?? null,
    oomKills: group.oomKills,
    cpuUsageUsec: group.cpu?.usageUsec ?? null,
    periods: group.cpu?.periods ?? null,
    throttledPeriods: group.cpu?.throttledPeriods ?? null,
  };
}

/** The share of `processors` the group used between two readings (0–1), `null` when either lacks the count. */
export function cpuShare(before: Reading, after: Reading, processors: number): number | null {
  if (before.cpuUsageUsec === null || after.cpuUsageUsec === null) return null;
  const seconds = (Date.parse(after.at) - Date.parse(before.at)) / 1000;
  const used = after.cpuUsageUsec - before.cpuUsageUsec;
  if (seconds <= 0 || used < 0) return null;
  return Math.min(1, used / 1e6 / seconds / processors);
}

/** The share of scheduling periods in which the kernel held the group back for its limit, between two readings. */
export function throttledShare(before: Reading, after: Reading): number | null {
  if (before.periods === null || after.periods === null || before.throttledPeriods === null || after.throttledPeriods === null) return null;
  const periods = after.periods - before.periods;
  const throttled = after.throttledPeriods - before.throttledPeriods;
  if (periods <= 0 || throttled < 0) return periods === 0 ? 0 : null;
  return throttled / periods;
}

/** Where the kill count rose between neighbouring readings; a count that fell (a new group) starts over. */
export function oomKillsIn(readings: Reading[]): OomKill[] {
  const kills: OomKill[] = [];
  for (let i = 1; i < readings.length; i++) {
    const before = readings[i - 1]?.oomKills;
    const after = readings[i];
    if (before == null || after?.oomKills == null || after.oomKills <= before) continue;
    kills.push({ at: after.at, count: after.oomKills - before });
  }
  return kills;
}

const POINT_MS = 5 * 60 * 1000;

/** One point per five minutes: the highest memory in it and the processor share over it (from the reading before it). */
export function historyOf(readings: Reading[], processors: number): HealthSample[] {
  const buckets = new Map<number, { memory: number[]; first: Reading; last: Reading }>();
  let before: Reading | undefined;
  for (const reading of readings) {
    const key = Math.floor(Date.parse(reading.at) / POINT_MS) * POINT_MS;
    const bucket = buckets.get(key) ?? { memory: [], first: before ?? reading, last: reading };
    if (reading.memoryBytes !== null) bucket.memory.push(reading.memoryBytes);
    bucket.last = reading;
    buckets.set(key, bucket);
    before = reading;
  }
  return [...buckets.entries()].map(([key, bucket]) => ({
    at: new Date(key).toISOString(),
    memoryBytes: bucket.memory.length > 0 ? Math.max(...bucket.memory) : null,
    cpu: bucket.first === bucket.last ? null : cpuShare(bucket.first, bucket.last, processors),
  }));
}
