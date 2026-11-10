import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { agentsApi, workspaceApi } from "@trackwall/protocol";
import { viewer, waitFor } from "./support/agents.ts";
import { sandboxProgramsFolder } from "./support/sandbox-programs.ts";
import { FAKE_COPILOT, ONE_REPO, startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

// `sandbox` (ADR-181) and `supervisor` (ADR-78) set in Settings › Agents (ADR-239) through the API the UI calls: what
// Settings saves is what `workspace.yaml` holds, and what the next task or supervisor starts with.

const TOKEN = "g".repeat(43);
let daemon: Awaited<ReturnType<typeof startSessionApi>>;

beforeAll(async () => {
  // The sandbox's programs in front of `PATH`, so that the sandbox can run on a runner without them; no `sandbox` key.
  const path = `${sandboxProgramsFolder()}${delimiter}${process.env.PATH ?? ""}`;
  daemon = await startSessionApi(TOKEN, {
    ...ONE_REPO,
    sandboxTasks: null,
    copilot: { command: FAKE_COPILOT.command, env: () => ({ ...process.env, PATH: path }) },
  });
}, SLOW_TEST_TIMEOUT_MS);

afterAll(async () => {
  await daemon.stop();
}, 30_000);

function workspaceYaml(): string {
  return readFileSync(join(daemon.home, "workspace.yaml"), "utf8");
}

/** The arguments the fake Copilot CLI printed for `session`, once it printed one starting with `last`. */
async function argumentsOf(session: string, last: string): Promise<string[]> {
  const window = viewer(daemon.facade.agents, session);
  await waitFor(daemon.facade.agents, session, () => window.text().includes(`Argument: ${last}`), `${last} on the screen`);
  window.attachment.detach();
  return window
    .text()
    .split(/\r?\n/)
    .filter((line) => line.startsWith("Argument: "))
    .map((line) => line.slice("Argument: ".length).trim());
}

function runningSessionOf(task: string): string {
  const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === task && s.run.kind === "running");
  if (!session) throw new Error(`task ${task} has no running session`);
  return session.id;
}

describe.skipIf(process.versions.bun === undefined)("the sandbox set in Settings (real PTY and git, fake Copilot CLI)", () => {
  test(
    "choosing every task writes sandbox.tasks: all, and the next task that asks for approvals starts in the sandbox",
    async () => {
      const before = await daemon.post(agentsApi.startOptions, {});
      expect(before.sandbox).toMatchObject({ tasks: process.platform === "linux" ? "auto" : "off", chosen: false });

      const saved = await daemon.post(workspaceApi.setSandbox, { tasks: "all" });

      expect(saved).toMatchObject({ sandbox: { tasks: "all" }, sandboxProblem: null });
      expect(workspaceYaml()).toContain("sandbox:\n  tasks: all\n");
      expect((await daemon.post(agentsApi.startOptions, {})).sandbox).toEqual({ tasks: "all", problem: null, chosen: true });
      const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "describe the repo", approvals: "ask" });
      expect(task.sandbox).toBe(true);
      expect(await argumentsOf(runningSessionOf(task.id), "--session-id=")).toContain("--sandbox");
      await daemon.post(agentsApi.stop, { session: runningSessionOf(task.id) });
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "choosing none writes sandbox.tasks: off, and the next task without approvals starts outside the sandbox",
    async () => {
      await daemon.post(workspaceApi.setSandbox, { tasks: "off" });

      expect(workspaceYaml()).toContain("sandbox:\n  tasks: off\n");
      const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "map the endpoints", approvals: "auto" });
      expect(task.sandbox).toBe(false);
      expect(await argumentsOf(runningSessionOf(task.id), "--session-id=")).not.toContain("--sandbox");
      await daemon.post(agentsApi.stop, { session: runningSessionOf(task.id) });
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test("the default removes the key, so the daemon chooses for this computer again", async () => {
    const saved = await daemon.post(workspaceApi.setSandbox, { tasks: null });

    expect(saved).toMatchObject({ sandbox: null, sandboxProblem: null });
    expect(workspaceYaml()).not.toContain("sandbox:");
    expect((await daemon.post(agentsApi.startOptions, {})).sandbox.chosen).toBe(false);
  });

  test("a value written wrong by hand shows in Settings and refuses tasks, and saving a choice fixes it", async () => {
    writeFileSync(join(daemon.home, "workspace.yaml"), `${workspaceYaml()}sandbox:\n  tasks: none\n`);

    const broken = await daemon.post(workspaceApi.settings, {});
    expect(broken.sandbox).toBeNull();
    expect(broken.sandboxProblem).toContain("sandbox");
    await expect(daemon.post(agentsApi.startOptions, {})).rejects.toThrow(/sandbox/);

    const fixed = await daemon.post(workspaceApi.setSandbox, { tasks: "auto" });
    expect(fixed).toMatchObject({ sandbox: { tasks: "auto" }, sandboxProblem: null });
    expect(workspaceYaml()).not.toContain("none");
  });
});

describe.skipIf(process.versions.bun === undefined)(
  "whether the supervisor changes code, set in Settings (real PTY, fake Copilot CLI)",
  () => {
    test(
      "turned on it writes supervisor.changesCode: true and the supervisor starts without the shell and write denial; turned off the key goes and the denial is back",
      async () => {
        const on = await daemon.post(workspaceApi.setSupervisor, { changesCode: true });

        expect(on).toMatchObject({ supervisor: { changesCode: true }, supervisorProblem: null });
        expect(workspaceYaml()).toContain("supervisor:\n  changesCode: true\n");
        const free = await daemon.post(agentsApi.startSupervisor, { conversation: "new", view: "terminal" });
        const freeArguments = await argumentsOf(free.id, "--session-id=");
        expect(freeArguments).not.toContain("--deny-tool=shell");
        expect(freeArguments).not.toContain("--deny-tool=write");
        await daemon.post(agentsApi.stop, { session: free.id });

        const off = await daemon.post(workspaceApi.setSupervisor, { changesCode: false });

        expect(off).toMatchObject({ supervisor: { changesCode: false }, supervisorProblem: null });
        expect(workspaceYaml()).not.toContain("supervisor:");
        const denied = await daemon.post(agentsApi.startSupervisor, { conversation: "new", view: "terminal" });
        const deniedArguments = await argumentsOf(denied.id, "--session-id=");
        expect(deniedArguments).toContain("--deny-tool=shell");
        expect(deniedArguments).toContain("--deny-tool=write");
        await daemon.post(agentsApi.stop, { session: denied.id });
      },
      SLOW_TEST_TIMEOUT_MS,
    );
  },
);
