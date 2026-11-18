import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * What the container's control group (cgroup v2) counts, read from its files inside the container (ADR-279). A
 * container sees its own group at `/sys/fs/cgroup`; on cgroup v1 or where a file is missing, that part is `null`, and
 * the panel says it is not available here. The parsers are pure, so that tests feed them the kernel's text.
 */

export const CONTROL_GROUP_ROOT = join("/", "sys", "fs", "cgroup");

export interface ControlGroupReading {
  memory: { current: number; max: number | null } | null;
  /** `oom_kill` of `memory.events`: processes the kernel killed for the group's memory since it was made. */
  oomKills: number | null;
  /** `cpu.stat` totals and the limit of `cpu.max` in processors (`null` without one). */
  cpu: { usageUsec: number; periods: number; throttledPeriods: number; limit: number | null } | null;
  processes: { current: number; max: number | null } | null;
}

/** `max` or a number, as in `memory.max` and `pids.max`; `null` for no limit. */
export function parseLimit(text: string): number | null | undefined {
  const value = text.trim();
  if (value === "max") return null;
  return parseCount(value);
}

/** A whole number the kernel wrote; `undefined` for anything else. */
function parseCount(text: string): number | undefined {
  const value = text.trim();
  return /^\d+$/.test(value) ? Number(value) : undefined;
}

/** `key value` lines, as in `memory.events` and `cpu.stat`. */
export function parseKeyValues(text: string): Map<string, number> {
  const values = new Map<string, number>();
  for (const line of text.split("\n")) {
    const [key, value, ...rest] = line.trim().split(/\s+/);
    const count = value === undefined ? undefined : parseCount(value);
    if (key && count !== undefined && rest.length === 0) values.set(key, count);
  }
  return values;
}

/** `cpu.max` (`<quota> <period>` or `max <period>`) as processors: `200000 100000` is 2. */
export function parseCpuMax(text: string): number | null | undefined {
  const [quota, period] = text.trim().split(/\s+/);
  const each = period === undefined ? undefined : parseCount(period);
  if (each === undefined || each === 0) return undefined;
  if (quota === "max") return null;
  const total = quota === undefined ? undefined : parseCount(quota);
  return total === undefined ? undefined : total / each;
}

/** The control group's counts now; a part whose files are missing or unreadable is `null`. */
export async function readControlGroup(root: string): Promise<ControlGroupReading> {
  const read = (name: string) => readFile(join(root, name), "utf8").catch(() => null);
  const [memCurrent, memMax, memEvents, cpuStat, cpuMax, pidsCurrent, pidsMax] = await Promise.all([
    read("memory.current"),
    read("memory.max"),
    read("memory.events"),
    read("cpu.stat"),
    read("cpu.max"),
    read("pids.current"),
    read("pids.max"),
  ]);
  return {
    memory: memoryOf(memCurrent, memMax),
    oomKills: memEvents === null ? null : (parseKeyValues(memEvents).get("oom_kill") ?? null),
    cpu: cpuOf(cpuStat, cpuMax),
    processes: processesOf(pidsCurrent, pidsMax),
  };
}

function memoryOf(current: string | null, max: string | null): ControlGroupReading["memory"] {
  const used = current === null ? undefined : parseCount(current);
  if (used === undefined) return null;
  return { current: used, max: (max === null ? null : parseLimit(max)) ?? null };
}

function cpuOf(stat: string | null, max: string | null): ControlGroupReading["cpu"] {
  if (stat === null) return null;
  const values = parseKeyValues(stat);
  const usageUsec = values.get("usage_usec");
  if (usageUsec === undefined) return null;
  return {
    usageUsec,
    periods: values.get("nr_periods") ?? 0,
    throttledPeriods: values.get("nr_throttled") ?? 0,
    limit: (max === null ? null : parseCpuMax(max)) ?? null,
  };
}

function processesOf(current: string | null, max: string | null): ControlGroupReading["processes"] {
  const used = current === null ? undefined : parseCount(current);
  if (used === undefined) return null;
  return { current: used, max: (max === null ? null : parseLimit(max)) ?? null };
}
