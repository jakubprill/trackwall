import { describe, expect, test } from "bun:test";
import type { ContainerHealth } from "@trackwall/protocol";
import { containerAttentionCount, healthEvents, healthTiles, healthUptime, memoryBars } from "../src/lib/container-health.ts";

const GIB = 1024 ** 3;
const NOW = new Date("2026-11-18T12:00:00.000Z");

const HEALTH: ContainerHealth = {
  inContainer: true,
  controlGroup: true,
  containerStartedAt: "2026-11-18T08:00:00.000Z",
  daemonStartedAt: "2026-11-18T11:30:00.000Z",
  memory: { used: 3 * GIB, limit: 4 * GIB },
  memoryPeak: 3.5 * GIB,
  machine: { memoryBytes: 16 * GIB, processors: 8 },
  cpu: { limit: 2, used: 0.25, throttled: 0.1 },
  processes: { used: 57, limit: 4096 },
  disk: { free: 40 * GIB, total: 100 * GIB },
  oomKills: [{ at: "2026-11-18T10:00:00.000Z", count: 2 }],
  oomKillsTotal: 2,
  restarts: [{ at: "2026-11-18T11:30:00.000Z", exitCode: null, signal: "SIGKILL" }],
  backup: { lastAt: null, reposWithUnpushedWork: 0 },
  history: [],
  warnings: [],
};

describe("the container's health panel", () => {
  test("each tile shows the use against the container's limit, with the day's peak of memory", () => {
    expect(healthTiles(HEALTH)).toEqual([
      { label: "Memory", value: "3.0 GB of 4.0 GB", share: 0.75, note: "limit of the container, 3.5 GB at most today" },
      { label: "Processors", value: "25% of 2 processors", share: 0.25, note: "limit of the container; held back in 10% of the time" },
      { label: "Processes", value: "57 of 4096", share: 57 / 4096, note: "threads included; limit of the container" },
      { label: "Disk", value: "40.0 GB free", share: 0.6, note: "of 100.0 GB, shared with Docker's other containers and images" },
    ]);
  });

  test("without a limit a tile names the machine's, and without the files it says so", () => {
    const open = { ...HEALTH, memory: { used: 3 * GIB, limit: null }, cpu: { limit: null, used: null, throttled: null }, processes: null };
    expect(healthTiles(open).slice(0, 3)).toEqual([
      { label: "Memory", value: "3.0 GB", share: null, note: "no limit; the machine has 16.0 GB, 3.5 GB at most today" },
      { label: "Processors", value: "measuring…", share: null, note: "no limit; the machine has 8 processors" },
      { label: "Processes", value: "not available here", share: null, note: "" },
    ]);
  });

  test("the processes tile says that its count holds threads too, as the container's limit counts them (#589)", () => {
    const unlimited = { ...HEALTH, processes: { used: 757, limit: null } };
    expect(healthTiles(unlimited)[2]).toEqual({ label: "Processes", value: "757", share: null, note: "threads included; no limit" });
  });

  test("the day's kills and restarts are listed newest first", () => {
    expect(healthEvents(HEALTH, NOW).map((e) => e.text.split(",")[0])).toEqual([
      "The daemon crashed (SIGKILL) and started again",
      "2 processes were killed for memory",
    ]);
  });

  test("the memory bars are scaled to the limit, or to the highest point without one", () => {
    const history = [
      { at: "2026-11-18T11:50:00.000Z", memoryBytes: 1 * GIB, cpu: null },
      { at: "2026-11-18T11:55:00.000Z", memoryBytes: null, cpu: null },
      { at: "2026-11-18T12:00:00.000Z", memoryBytes: 2 * GIB, cpu: null },
    ];
    expect(memoryBars(history, 4 * GIB).bars.map((b) => b.percent)).toEqual([25, 50]);
    expect(memoryBars(history, null)).toMatchObject({ top: 2 * GIB, bars: [{ percent: 50 }, { percent: 100 }] });
  });

  test("the uptime names the container and the daemon", () => {
    expect(healthUptime(HEALTH, NOW)).toBe("The container started 4 h ago, Trackwall's daemon 30 min ago.");
  });
});

describe("the number on Settings' icon", () => {
  test("counts the container's warnings, which Settings › Diagnostics explains", () => {
    const warns: ContainerHealth = {
      ...HEALTH,
      warnings: [
        { id: "oom-kill", text: "The kernel killed a process for lack of memory in the last hour." },
        { id: "disk-low", text: "The disk has 2.0 GB free." },
      ],
    };
    expect(containerAttentionCount(warns)).toBe(2);
  });

  test("work only in the container counts while its last backup is old, once, as that warning", () => {
    const freshBackup: ContainerHealth = {
      ...HEALTH,
      backup: { lastAt: "2026-11-18T09:00:00.000Z", reposWithUnpushedWork: 3 },
      warnings: [],
    };
    expect(containerAttentionCount(freshBackup)).toBe(0);

    const oldBackup: ContainerHealth = {
      ...HEALTH,
      backup: { lastAt: null, reposWithUnpushedWork: 3 },
      warnings: [{ id: "backup-old", text: "3 repos have work on no remote, and the last backup is not made yet." }],
    };
    expect(containerAttentionCount(oldBackup)).toBe(1);
  });

  test("is zero outside a container and until the daemon answers", () => {
    expect(containerAttentionCount({ ...HEALTH, inContainer: false })).toBe(0);
    expect(containerAttentionCount(undefined)).toBe(0);
  });
});
