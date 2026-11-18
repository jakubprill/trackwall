import type { ContainerHealth, HealthWarning } from "@trackwall/protocol";
import { gigabytes } from "../../platform/disk-space.ts";
import { type Reading, throttledShare } from "./health-sample.ts";

/**
 * When the container needs the user (ADR-279): the rules are here once, for the panel now and Home later. Each one
 * waits for a lasting state, not one sample, so that a build's short peak does not raise a warning.
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const MEMORY_FULL_SHARE = 0.9;
const MEMORY_FULL_FOR_MS = 5 * MINUTE_MS;
const THROTTLED_SHARE = 0.2;
const THROTTLED_FOR_MS = 10 * MINUTE_MS;
const PROCESSES_FULL_SHARE = 0.9;
const RECENT_MS = HOUR_MS;
const BACKUP_OLD_MS = 24 * HOUR_MS;
/** A sampler that missed this much of a window has not seen the state last through it. */
const SAMPLE_GAP_MS = 2 * MINUTE_MS;

type Facts = Pick<ContainerHealth, "memory" | "processes" | "disk" | "oomKills" | "restarts" | "backup">;

interface Seen {
  facts: Facts;
  readings: Reading[];
  lowDiskBytes: number;
  now: Date;
}

/** The warnings the container's state adds up to, in the order the panel lists them. */
export function healthWarnings(facts: Facts, readings: Reading[], lowDiskBytes: number, now: Date): HealthWarning[] {
  const seen = { facts, readings, lowDiskBytes, now };
  return [memoryFull, oomKill, cpuThrottled, diskLow, processesFull, daemonRestarted, backupOld].flatMap((rule) => rule(seen) ?? []);
}

function memoryFull({ facts, readings, now }: Seen): HealthWarning | null {
  const limit = facts.memory?.limit ?? null;
  if (limit === null) return null;
  const run = lasting(readings, MEMORY_FULL_FOR_MS, now);
  if (run === null || !run.every((r) => r.memoryBytes !== null && r.memoryBytes >= limit * MEMORY_FULL_SHARE)) return null;
  return {
    id: "memory-full",
    text: `Memory has been above ${MEMORY_FULL_SHARE * 100}% of the container's ${gigabytes(limit)} for ${MEMORY_FULL_FOR_MS / MINUTE_MS} minutes; the next build may be killed. Give the container more memory or run fewer things at once.`,
  };
}

function oomKill({ facts, now }: Seen): HealthWarning | null {
  const kills = facts.oomKills.filter((k) => recent(k.at, now)).reduce((n, k) => n + k.count, 0);
  if (kills === 0) return null;
  return {
    id: "oom-kill",
    text: `The kernel killed ${kills === 1 ? "a process" : `${kills} processes`} in the last hour because the container ran out of memory. A build or a test that ended without a reason may have been one.`,
  };
}

function cpuThrottled({ readings, now }: Seen): HealthWarning | null {
  const run = lasting(readings, THROTTLED_FOR_MS, now);
  const first = run?.[0];
  const last = run?.[run.length - 1];
  if (!first || !last || first === last || (throttledShare(first, last) ?? 0) <= THROTTLED_SHARE) return null;
  return {
    id: "cpu-throttled",
    text: `The container's processor limit has held it back for ${THROTTLED_FOR_MS / MINUTE_MS} minutes; builds run slower than they could. Give it more processors.`,
  };
}

function diskLow({ facts, lowDiskBytes }: Seen): HealthWarning | null {
  if (facts.disk === null || facts.disk.free >= lowDiskBytes) return null;
  return {
    id: "disk-low",
    text: `Only ${gigabytes(facts.disk.free)} free on the container's disk; builds and git start failing when it fills.`,
  };
}

function processesFull({ facts }: Seen): HealthWarning | null {
  const processes = facts.processes;
  if (processes?.limit == null || processes.used < processes.limit * PROCESSES_FULL_SHARE) return null;
  return {
    id: "processes-full",
    text: `${processes.used} of the container's ${processes.limit} processes are in use; new ones will fail to start.`,
  };
}

function daemonRestarted({ facts, now }: Seen): HealthWarning | null {
  if (!facts.restarts.some((r) => recent(r.at, now))) return null;
  return { id: "daemon-restarted", text: "Trackwall's daemon crashed in the last hour and started again; its log says why." };
}

function backupOld({ facts, now }: Seen): HealthWarning | null {
  const { lastAt, reposWithUnpushedWork } = facts.backup;
  if (reposWithUnpushedWork === 0 || (lastAt !== null && now.getTime() - Date.parse(lastAt) <= BACKUP_OLD_MS)) return null;
  return {
    id: "backup-old",
    text: `${reposWithUnpushedWork === 1 ? "A repo has" : `${reposWithUnpushedWork} repos have`} work on no remote, and the last backup is ${lastAt === null ? "not made yet" : "more than a day old"}. Make one before you change the container.`,
  };
}

function recent(at: string, now: Date): boolean {
  return now.getTime() - Date.parse(at) <= RECENT_MS;
}

/** The readings of the last `ms`, if they cover it without a gap a sampler would not leave. */
function lasting(readings: Reading[], ms: number, now: Date): Reading[] | null {
  const from = now.getTime() - ms;
  const run = readings.filter((r) => Date.parse(r.at) >= from - SAMPLE_GAP_MS);
  const first = run[0];
  if (first === undefined || Date.parse(first.at) > from) return null;
  for (let i = 1; i < run.length; i++) {
    const gap = Date.parse(run[i]?.at ?? "") - Date.parse(run[i - 1]?.at ?? "");
    if (!(gap <= SAMPLE_GAP_MS)) return null;
  }
  const last = run[run.length - 1];
  return last && now.getTime() - Date.parse(last.at) <= SAMPLE_GAP_MS ? run : null;
}
