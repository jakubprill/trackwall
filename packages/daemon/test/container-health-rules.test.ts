import { describe, expect, test } from "bun:test";
import type { ContainerHealth } from "@trackwall/protocol";
import { containerStart } from "../src/modules/container-health/container-start.ts";
import { parseCpuMax, parseKeyValues, parseLimit } from "../src/modules/container-health/control-group.ts";
import { cpuShare, historyOf, oomKillsIn, type Reading, throttledShare } from "../src/modules/container-health/health-sample.ts";
import { healthWarnings } from "../src/modules/container-health/health-warnings.ts";

// The pure parts of the container's health (ADR-279): the kernel's text, shares between readings, and when a state
// lasted long enough to warn.

const GIB = 1024 ** 3;
const NOW = new Date("2026-11-18T12:00:00.000Z");

function reading(minutesAgo: number, fields: Partial<Reading> = {}): Reading {
  return {
    at: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
    memoryBytes: null,
    oomKills: null,
    cpuUsageUsec: null,
    periods: null,
    throttledPeriods: null,
    ...fields,
  };
}

/** A reading every 30 seconds over the last `minutes`. */
function every30s(minutes: number, fields: (i: number) => Partial<Reading>): Reading[] {
  return Array.from({ length: minutes * 2 + 1 }, (_, i) => reading(minutes - i / 2, fields(i)));
}

const CALM: Pick<ContainerHealth, "memory" | "processes" | "disk" | "oomKills" | "restarts" | "backup"> = {
  memory: { used: 1 * GIB, limit: 4 * GIB },
  processes: { used: 50, limit: 4096 },
  disk: { free: 50 * GIB, total: 100 * GIB },
  oomKills: [],
  restarts: [],
  backup: { lastAt: null, reposWithUnpushedWork: 0 },
};
const LOW_DISK = 10 * GIB;

describe("the control group's files", () => {
  test("a limit is a number or max, which means none", () => {
    expect(parseLimit("4294967296\n")).toBe(4294967296);
    expect(parseLimit("max\n")).toBeNull();
    expect(parseLimit("lots")).toBeUndefined();
  });

  test("cpu.max gives the limit in processors", () => {
    expect(parseCpuMax("200000 100000\n")).toBe(2);
    expect(parseCpuMax("50000 100000")).toBe(0.5);
    expect(parseCpuMax("max 100000\n")).toBeNull();
    expect(parseCpuMax("100000")).toBeUndefined();
  });

  test("key-value files keep the counts and skip lines that are not one", () => {
    expect(parseKeyValues("oom 1\noom_kill 2\nbroken\nx y z\n")).toEqual(
      new Map([
        ["oom", 1],
        ["oom_kill", 2],
      ]),
    );
  });

  test("the container starts when its first process did, after the boot time", () => {
    const procOne = "1 (my (odd) init) S 0 1 1 0 -1 4194560 2315 499 0 2 3 35 0 0 20 0 14 0 12345 37687296 1359";
    expect(containerStart(procOne, "cpu 1 2 3\nbtime 1795028514\nprocesses 9\n")).toEqual(new Date((1795028514 + 123.45) * 1000));
    expect(containerStart(procOne, "cpu 1 2 3\n")).toBeNull();
  });
});

describe("shares between readings", () => {
  test("processor use is a share of the limit, and throttling a share of the periods", () => {
    const before = reading(1, { cpuUsageUsec: 0, periods: 0, throttledPeriods: 0 });
    const after = reading(0.5, { cpuUsageUsec: 30_000_000, periods: 300, throttledPeriods: 90 });
    expect(cpuShare(before, after, 2)).toBe(0.5);
    expect(throttledShare(before, after)).toBe(0.3);
  });

  test("a kill count that rises is a kill, and one that starts over is not", () => {
    const readings = [reading(3, { oomKills: 0 }), reading(2, { oomKills: 2 }), reading(1, { oomKills: 0 }), reading(0, { oomKills: 1 })];
    expect(oomKillsIn(readings).map((k) => k.count)).toEqual([2, 1]);
  });

  test("the history has one point per five minutes with its highest memory", () => {
    const readings = every30s(10, (i) => ({ memoryBytes: i === 3 ? 3 * GIB : 1 * GIB, cpuUsageUsec: i * 1_000_000 }));
    const history = historyOf(readings, 2);
    expect(history.map((p) => p.at)).toEqual(["2026-11-18T11:50:00.000Z", "2026-11-18T11:55:00.000Z", "2026-11-18T12:00:00.000Z"]);
    expect(history[0]?.memoryBytes).toBe(3 * GIB);
    // 10 processor-seconds in the 300 seconds since the reading before the point, on a limit of 2 processors.
    expect(history[1]?.cpu).toBeCloseTo(10 / 300 / 2, 5);
  });
});

describe("when the container needs the user", () => {
  test("memory above 90% of the limit for five minutes warns, a short peak does not", () => {
    const full = every30s(6, () => ({ memoryBytes: 3.8 * GIB }));
    expect(healthWarnings(CALM, full, LOW_DISK, NOW).map((w) => w.id)).toEqual(["memory-full"]);

    const peak = every30s(6, (i) => ({ memoryBytes: i === 2 ? 2 * GIB : 3.8 * GIB }));
    expect(healthWarnings(CALM, peak, LOW_DISK, NOW)).toEqual([]);

    const tooShort = every30s(3, () => ({ memoryBytes: 3.8 * GIB }));
    expect(healthWarnings(CALM, tooShort, LOW_DISK, NOW)).toEqual([]);

    const noLimit = { ...CALM, memory: { used: 3.8 * GIB, limit: null } };
    expect(healthWarnings(noLimit, full, LOW_DISK, NOW)).toEqual([]);
  });

  test("a gap in the readings means the state was not seen to last", () => {
    const withGap = every30s(6, () => ({ memoryBytes: 3.8 * GIB })).filter((_, i) => i < 3 || i > 8);
    expect(healthWarnings(CALM, withGap, LOW_DISK, NOW)).toEqual([]);
  });

  test("throttling over a fifth of the periods for ten minutes warns", () => {
    const held = every30s(11, (i) => ({ periods: i * 300, throttledPeriods: i * 90 }));
    expect(healthWarnings(CALM, held, LOW_DISK, NOW).map((w) => w.id)).toEqual(["cpu-throttled"]);
    const light = every30s(11, (i) => ({ periods: i * 300, throttledPeriods: i * 30 }));
    expect(healthWarnings(CALM, light, LOW_DISK, NOW)).toEqual([]);
  });

  test("a kill or a restart in the last hour warns, an older one does not", () => {
    const recent = { ...CALM, oomKills: [{ at: reading(30).at, count: 1 }], restarts: [{ at: reading(10).at, exitCode: 1, signal: null }] };
    expect(healthWarnings(recent, [], LOW_DISK, NOW).map((w) => w.id)).toEqual(["oom-kill", "daemon-restarted"]);
    const old = { ...CALM, oomKills: [{ at: reading(90).at, count: 1 }], restarts: [{ at: reading(61).at, exitCode: 1, signal: null }] };
    expect(healthWarnings(old, [], LOW_DISK, NOW)).toEqual([]);
  });

  test("a low disk and processes near their limit warn", () => {
    const tight = { ...CALM, disk: { free: 4 * GIB, total: 100 * GIB }, processes: { used: 3700, limit: 4096 } };
    expect(healthWarnings(tight, [], LOW_DISK, NOW).map((w) => w.id)).toEqual(["disk-low", "processes-full"]);
  });

  test("work on no remote with no backup in the last day warns, and none when all is pushed", () => {
    const never = { ...CALM, backup: { lastAt: null, reposWithUnpushedWork: 2 } };
    expect(healthWarnings(never, [], LOW_DISK, NOW).map((w) => w.text)).toEqual([
      "2 repos have work on no remote, and the last backup is not made yet. Make one before you change the container.",
    ]);
    const old = { ...CALM, backup: { lastAt: reading(25 * 60).at, reposWithUnpushedWork: 1 } };
    expect(healthWarnings(old, [], LOW_DISK, NOW).map((w) => w.id)).toEqual(["backup-old"]);
    const fresh = { ...CALM, backup: { lastAt: reading(60).at, reposWithUnpushedWork: 1 } };
    expect(healthWarnings(fresh, [], LOW_DISK, NOW)).toEqual([]);
    const pushed = { ...CALM, backup: { lastAt: null, reposWithUnpushedWork: 0 } };
    expect(healthWarnings(pushed, [], LOW_DISK, NOW)).toEqual([]);
  });
});
