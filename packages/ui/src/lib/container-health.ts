import type { ContainerHealth, HealthSample } from "@trackwall/protocol";
import { formatBytes, relativeTime } from "./format.ts";

/**
 * What the container's health panel shows (ADR-279): one tile per resource with its use against its limit, the day's
 * memory as bars, and the day's events. Pure functions, tested in `test/container-health.test.ts`.
 */

export interface HealthTile {
  label: string;
  value: string;
  /** The use as a share of the limit (0–1), for the tile's bar; `null` without a limit to compare with. */
  share: number | null;
  /** A line under the value: the limit, or why there is none. */
  note: string;
}

const NOT_HERE = "not available here";

export function healthTiles(health: ContainerHealth): HealthTile[] {
  return [memoryTile(health), cpuTile(health), processesTile(health), diskTile(health)];
}

function memoryTile({ memory, memoryPeak, machine }: ContainerHealth): HealthTile {
  if (memory === null) return { label: "Memory", value: NOT_HERE, share: null, note: "" };
  const peak = memoryPeak === null ? "" : `, ${formatBytes(memoryPeak)} at most today`;
  if (memory.limit === null) {
    return {
      label: "Memory",
      value: formatBytes(memory.used),
      share: null,
      note: `no limit; the machine has ${formatBytes(machine.memoryBytes)}${peak}`,
    };
  }
  return {
    label: "Memory",
    value: `${formatBytes(memory.used)} of ${formatBytes(memory.limit)}`,
    share: memory.used / memory.limit,
    note: `limit of the container${peak}`,
  };
}

function cpuTile({ cpu, machine }: ContainerHealth): HealthTile {
  if (cpu === null) return { label: "Processors", value: NOT_HERE, share: null, note: "" };
  const processors = cpu.limit ?? machine.processors;
  const value = cpu.used === null ? "measuring…" : `${percent(cpu.used)} of ${countOf(processors)}`;
  const held = cpu.throttled !== null && cpu.throttled > 0 ? `; held back in ${percent(cpu.throttled)} of the time` : "";
  const note = cpu.limit === null ? `no limit; the machine has ${countOf(machine.processors)}` : `limit of the container${held}`;
  return { label: "Processors", value, share: cpu.used, note };
}

function processesTile({ processes }: ContainerHealth): HealthTile {
  if (processes === null) return { label: "Processes", value: NOT_HERE, share: null, note: "" };
  if (processes.limit === null) return { label: "Processes", value: String(processes.used), share: null, note: "no limit" };
  return {
    label: "Processes",
    value: `${processes.used} of ${processes.limit}`,
    share: processes.used / processes.limit,
    note: "limit of the container",
  };
}

function diskTile({ disk }: ContainerHealth): HealthTile {
  if (disk === null) return { label: "Disk", value: NOT_HERE, share: null, note: "" };
  return {
    label: "Disk",
    value: `${formatBytes(disk.free)} free`,
    share: (disk.total - disk.free) / disk.total,
    note: `of ${formatBytes(disk.total)}, shared with Docker's other containers and images`,
  };
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function countOf(processors: number): string {
  const n = Number.isInteger(processors) ? String(processors) : processors.toFixed(1);
  return `${n} ${processors === 1 ? "processor" : "processors"}`;
}

export interface MemoryBar {
  at: string;
  /** The bar's height as a share of the chart (0–100). */
  percent: number;
  /** What hovering the bar says: when and how much. */
  label: string;
}

/** The day's memory as bars against the limit, or against the highest point without one. */
export function memoryBars(history: HealthSample[], limit: number | null): { top: number; bars: MemoryBar[] } {
  const seen = history.flatMap((p) => (p.memoryBytes === null ? [] : [p.memoryBytes]));
  const top = limit ?? Math.max(1, ...seen);
  const bars = history.flatMap((point) =>
    point.memoryBytes === null
      ? []
      : [
          {
            at: point.at,
            percent: Math.min(100, (point.memoryBytes / top) * 100),
            label: `${clock(point.at)}: ${formatBytes(point.memoryBytes)}`,
          },
        ],
  );
  return { top, bars };
}

/** The day's kills for memory and restarts of the daemon, newest first, in words. */
export function healthEvents(health: ContainerHealth, now: Date): { key: string; text: string }[] {
  const kills = health.oomKills.map((k) => ({
    at: k.at,
    text: `${k.count === 1 ? "A process was" : `${k.count} processes were`} killed for memory`,
  }));
  const restarts = health.restarts.map((r) => ({
    at: r.at,
    text: `The daemon crashed (${r.signal ?? `exit code ${r.exitCode}`}) and started again`,
  }));
  return [...kills, ...restarts]
    .sort((a, b) => b.at.localeCompare(a.at))
    .map((e, i) => ({ key: `${e.at}-${i}`, text: `${e.text}, ${relativeTime(e.at, now)} (${clock(e.at)})` }));
}

/** How long the container and the daemon have run. */
export function healthUptime(health: ContainerHealth, now: Date): string {
  const daemon = relativeTime(health.daemonStartedAt, now);
  if (health.containerStartedAt === null) return `Trackwall's daemon started ${daemon}.`;
  return `The container started ${relativeTime(health.containerStartedAt, now)}, Trackwall's daemon ${daemon}.`;
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}
