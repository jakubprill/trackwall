import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFacade } from "../src/facade.ts";
import { fakeHostingClis } from "./support/hosting.ts";

// The container's health (ADR-279) through the real facade, on a folder of control group files as the kernel writes them
// inside a container: what the panel shows now, a kill for memory as an event and a warning, and a day of readings
// kept in the state folder across a daemon restart.

const GIB = 1024 ** 3;

function controlGroup(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "trackwall-cgroup-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  return root;
}

const LIMITED = {
  "memory.current": `${3 * GIB}\n`,
  "memory.max": `${4 * GIB}\n`,
  "memory.peak": `${3.5 * GIB}\n`,
  "memory.events": "low 0\nhigh 0\nmax 12\noom 1\noom_kill 1\noom_group_kill 0\n",
  "cpu.stat": "usage_usec 5000000\nuser_usec 4000000\nsystem_usec 1000000\nnr_periods 100\nnr_throttled 5\nthrottled_usec 20000\n",
  "cpu.max": "200000 100000\n",
  "pids.current": "57\n",
  "pids.max": "4096\n",
};

async function facadeWith(inContainer: boolean, root: string, home = mkdtempSync(join(tmpdir(), "trackwall-health-home-"))) {
  const projects = mkdtempSync(join(tmpdir(), "trackwall-health-projects-"));
  const facade = createFacade({
    inContainer,
    home,
    homeFrom: "flag",
    openUrl: () => {},
    openFolder: () => {},
    miseCommand: ["trackwall-test-no-mise"],
    copilotCommand: ["trackwall-test-no-copilot"],
    version: "0.0.0-test",
    sessionHook: () => ({ url: "http://127.0.0.1:9/hooks/unused", headers: {} }),
    sessionMcpServer: () => ({ url: "http://127.0.0.1:9/mcp", headers: {} }),
    hostingClis: fakeHostingClis({}).clis,
    userEnv: async () => process.env,
    log: () => {},
    controlGroupRoot: root,
    diskSpace: async () => ({ disk: 1, free: 50 * GIB, total: 100 * GIB }),
  });
  await facade.workspace.setProjectsDir(projects);
  return { facade, home };
}

describe("the container's health (ADR-279)", () => {
  test("in a container with limits, the panel shows memory, processors and processes against them, and the disk", async () => {
    const { facade } = await facadeWith(true, controlGroup(LIMITED));

    const health = await facade.containerHealth.state();

    expect(health).toMatchObject({
      inContainer: true,
      controlGroup: true,
      memory: { used: 3 * GIB, limit: 4 * GIB },
      cpu: { limit: 2, used: null, throttled: null },
      processes: { used: 57, limit: 4096 },
      disk: { free: 50 * GIB, total: 100 * GIB },
      oomKillsTotal: 1,
      oomKills: [],
      restarts: [],
      backup: { lastAt: null, reposWithUnpushedWork: 0 },
      warnings: [],
    });
  });

  test("a process killed for memory between two readings shows as a kill and a warning", async () => {
    const root = controlGroup(LIMITED);
    const { facade } = await facadeWith(true, root);
    await facade.containerHealth.sample();
    expect((await facade.containerHealth.state()).warnings).toEqual([]);

    // What the kernel writes when it kills a build's JVM for the group's memory.
    writeFileSync(join(root, "memory.events"), "low 0\nhigh 0\nmax 40\noom 2\noom_kill 3\noom_group_kill 0\n");
    await facade.containerHealth.sample();

    const health = await facade.containerHealth.state();
    expect(health.oomKills).toEqual([{ at: expect.any(String), count: 2 }]);
    expect(health.oomKillsTotal).toBe(3);
    expect(health.warnings.map((w) => w.id)).toEqual(["oom-kill"]);
    expect(health.warnings[0]?.text).toContain("killed 2 processes in the last hour");
  });

  test("the readings of the day stay in the state folder, so a restarted daemon still shows them", async () => {
    const root = controlGroup(LIMITED);
    const first = await facadeWith(true, root);
    await first.facade.containerHealth.sample();
    await first.facade.containerHealth.sample();

    const again = await facadeWith(true, root, first.home);
    const health = await again.facade.containerHealth.state();

    // One point per five minutes: two when the readings fell on both sides of a boundary.
    expect(health.history.length).toBeGreaterThan(0);
    expect(health.history.map((p) => p.memoryBytes)).toEqual(health.history.map(() => 3 * GIB));
    expect(health.memoryPeak).toBe(3 * GIB);
  });

  test("without control group files (cgroup v1, or none of its own) the rows that need them are not available", async () => {
    const empty = mkdtempSync(join(tmpdir(), "trackwall-cgroup-"));
    mkdirSync(join(empty, "unrelated"));
    const { facade } = await facadeWith(true, empty);

    const health = await facade.containerHealth.state();

    expect(health).toMatchObject({ controlGroup: false, memory: null, cpu: null, processes: null, oomKillsTotal: null });
    expect(health.disk).toEqual({ free: 50 * GIB, total: 100 * GIB });
  });

  test("outside a container there is nothing to show", async () => {
    const { facade } = await facadeWith(false, controlGroup(LIMITED));

    const health = await facade.containerHealth.state();

    expect(health).toMatchObject({ inContainer: false, memory: null, disk: null, warnings: [] });
  });
});
