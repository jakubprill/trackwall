import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentsApi, workspaceApi } from "@trackwall/protocol";
import { DomainError } from "../src/infra/errors.ts";
import { computerDefault, daemonComputer, runningTasksWarningState } from "../src/modules/agents/running-tasks-warning.ts";
import { ONE_REPO, startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

// Above how many running tasks a start warns (ADR-244): the computer's default and `runningTasksWarning` set in
// Settings › Agents, through the API the New session form and Settings call.

const GIB = 1024 ** 3;

describe("the computer's default for the running tasks warning", () => {
  test("a laptop with 8 logical processors and 16 GB, which the system reports as 15.6 GiB, warns above 4 tasks", () => {
    expect(computerDefault({ processors: 8, memoryBytes: 15.6 * GIB })).toBe(4);
  });

  test("a workstation with 16 logical processors and 32 GiB warns above 8 tasks", () => {
    expect(computerDefault({ processors: 16, memoryBytes: 32 * GIB })).toBe(8);
  });

  test("memory limits it when it is the smaller share: 16 processors and 8 GiB warn above 2", () => {
    expect(computerDefault({ processors: 16, memoryBytes: 8 * GIB })).toBe(2);
  });

  test("a small container with 2 processors and 2 GiB still lets 2 tasks run without a warning", () => {
    expect(computerDefault({ processors: 2, memoryBytes: 2 * GIB })).toBe(2);
  });

  test("a key written wrong falls back to the default, since a warning must not stop a start", () => {
    const badKey = () => {
      throw new DomainError("invalid_config", "workspace.yaml: runningTasksWarning: expected a number");
    };
    expect(runningTasksWarningState(badKey, { processors: 8, memoryBytes: 16 * GIB }).above).toBe(4);
  });

  test("the setting wins over the default, and the state names the computer it was computed for", () => {
    expect(runningTasksWarningState(() => 6, { processors: 12, memoryBytes: 31.7 * GIB })).toEqual({
      above: 6,
      computerDefault: 6,
      processors: 12,
      memoryGiB: 31.7,
    });
  });

  test("the computer the daemon sees has processors and memory", () => {
    const computer = daemonComputer();
    expect(computer.processors).toBeGreaterThan(0);
    expect(computer.memoryBytes).toBeGreaterThan(0);
  });
});

const TOKEN = "w".repeat(43);
let daemon: Awaited<ReturnType<typeof startSessionApi>>;

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN, ONE_REPO);
}, SLOW_TEST_TIMEOUT_MS);

afterAll(async () => {
  await daemon.stop();
}, 30_000);

function workspaceFile(): string {
  return join(daemon.home, "workspace.yaml");
}

describe("the running tasks warning set in Settings (real daemon API)", () => {
  test("without the key the New session form gets the computer's default", async () => {
    const options = await daemon.post(agentsApi.startOptions, {});

    const computer = daemonComputer();
    expect(options.runningTasksWarning).toEqual({
      above: computerDefault(computer),
      computerDefault: computerDefault(computer),
      processors: computer.processors,
      memoryGiB: Math.round((computer.memoryBytes / GIB) * 10) / 10,
    });
    expect(await daemon.post(workspaceApi.settings, {})).toMatchObject({ runningTasksWarning: null, runningTasksWarningProblem: null });
  });

  test("saving 7 writes runningTasksWarning: 7 and the next start warns above 7", async () => {
    const saved = await daemon.post(workspaceApi.setRunningTasksWarning, { above: 7 });

    expect(saved).toMatchObject({ runningTasksWarning: 7, runningTasksWarningProblem: null });
    expect(readFileSync(workspaceFile(), "utf8")).toContain("runningTasksWarning: 7\n");
    expect((await daemon.post(agentsApi.startOptions, {})).runningTasksWarning.above).toBe(7);
  });

  test("a key written wrong by hand shows in Settings and the warning falls back to the computer's default", async () => {
    const yaml = readFileSync(workspaceFile(), "utf8").replace("runningTasksWarning: 7", "runningTasksWarning: many");
    writeFileSync(workspaceFile(), yaml);

    const settings = await daemon.post(workspaceApi.settings, {});
    const options = await daemon.post(agentsApi.startOptions, {});

    expect(settings.runningTasksWarning).toBeNull();
    expect(settings.runningTasksWarningProblem).toContain("runningTasksWarning");
    expect(options.runningTasksWarning.above).toBe(options.runningTasksWarning.computerDefault);
  });

  test("going back to the default removes the key", async () => {
    await daemon.post(workspaceApi.setRunningTasksWarning, { above: null });

    expect(readFileSync(workspaceFile(), "utf8")).not.toContain("runningTasksWarning");
    expect(await daemon.post(workspaceApi.settings, {})).toMatchObject({ runningTasksWarning: null, runningTasksWarningProblem: null });
  });

  test("a number outside 1 to 100 is refused", async () => {
    await expect(daemon.post(workspaceApi.setRunningTasksWarning, { above: 0 })).rejects.toThrow();
    await expect(daemon.post(workspaceApi.setRunningTasksWarning, { above: 101 })).rejects.toThrow();
  });
});
