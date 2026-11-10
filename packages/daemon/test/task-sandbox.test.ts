import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { agentsApi, doctorApi } from "@trackwall/protocol";
import { systemTempFolder, Vcs } from "../src/modules/vcs/vcs.ts";
import { Workspace } from "../src/modules/workspace/workspace.ts";
import { WorkspaceFile } from "../src/modules/workspace/workspace-file.ts";
import { viewer, waitFor } from "./support/agents.ts";
import { fakeHosting } from "./support/hosting.ts";
import { sandboxProgramsFolder } from "./support/sandbox-programs.ts";
import { FAKE_COPILOT, ONE_REPO, startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const TOKEN = "s".repeat(43);

/** The fake Copilot CLI with `PATH` as given, which is the `PATH` the daemon checks for bubblewrap, and `env` added. */
function fakeCopilotWithPath(path: string, env: Record<string, string> = {}) {
  return { command: FAKE_COPILOT.command, env: () => ({ ...process.env, PATH: path, ...env }) };
}

let daemon: Awaited<ReturnType<typeof startSessionApi>> | undefined;

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
}, 30_000);

function sessionOf(task: string): string {
  const session = daemon?.facade.agents.sessions().sessions.find((s) => s.task === task && s.run.kind === "running");
  if (!session) throw new Error(`task ${task} has no running session`);
  return session.id;
}

/** The arguments the fake Copilot CLI printed, once it printed `last`. */
async function argumentsOf(session: string, last: string): Promise<string[]> {
  if (!daemon) throw new Error("no daemon");
  const window = viewer(daemon.facade.agents, session);
  await waitFor(daemon.facade.agents, session, () => window.text().includes(`Argument: ${last}`), `${last} on the screen`);
  window.attachment.detach();
  return window
    .text()
    .split(/\r?\n/)
    .filter((line) => line.startsWith("Argument: "))
    .map((line) => line.slice("Argument: ".length).trim());
}

describe("sandbox in workspace.yaml and its default (ADR-181)", () => {
  function workspace(yaml: string | null, inContainer: boolean): Workspace {
    const path = join(mkdtempSync(join(tmpdir(), "trackwall-home-")), "workspace.yaml");
    if (yaml !== null) writeFileSync(path, yaml);
    return new Workspace({
      inContainer,
      file: new WorkspaceFile(path),
      vcs: new Vcs(systemTempFolder),
      hosting: fakeHosting().hosting,
      openEditor: () => {},
      openFolder: () => {},
      afterClone: async () => {},
    });
  }

  test("the workspace gives the key as it is, and nothing without it, whose default depends on this computer", () => {
    expect(workspace(null, false).sandboxSettings()).toBeNull();
    expect(workspace("sandbox:\n  tasks: off\n", false).sandboxSettings()).toEqual({ tasks: "off" });
    expect(workspace("sandbox:\n  tasks: all\n", true).sandboxSettings()).toEqual({ tasks: "all" });
  });

  test("a value Trackwall does not know is a configuration error, so that a typo never takes a task out of the sandbox", () => {
    expect(() => workspace("sandbox:\n  tasks: none\n", false).sandboxSettings()).toThrow(
      expect.objectContaining({ code: "invalid_config", message: expect.stringContaining("sandbox") }),
    );
  });
});

describe.skipIf(process.versions.bun === undefined)("a task in Copilot CLI's sandbox (ADR-181, real PTY and git, fake Copilot CLI)", () => {
  test(
    "a task without approvals starts Copilot CLI with --sandbox and keeps it on resume, and a task that asks starts without it",
    async () => {
      const path = `${sandboxProgramsFolder()}${delimiter}${process.env.PATH ?? ""}`;
      daemon = await startSessionApi(TOKEN, { ...ONE_REPO, sandboxTasks: "auto", copilot: fakeCopilotWithPath(path) });
      const options = await daemon.post(agentsApi.startOptions, {});
      expect(options.sandbox).toEqual({ tasks: "auto", problem: null, chosen: true });

      const auto = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "map the endpoints", approvals: "auto" });
      expect(auto.sandbox).toBe(true);
      const first = sessionOf(auto.id);
      expect(await argumentsOf(first, "--session-id=")).toContain("--sandbox");
      await daemon.facade.agents.stop(first);
      await daemon.facade.agents.resumeTask(auto.id);
      expect(await argumentsOf(sessionOf(auto.id), "--resume=")).toContain("--sandbox");

      const asking = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "describe the repo", approvals: "ask" });
      expect(asking.sandbox).toBe(false);
      expect(await argumentsOf(sessionOf(asking.id), "--session-id=")).not.toContain("--sandbox");
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "a task whose sandbox offers to install its certificate authority waits for you, and outside the terminal it can only go on without installing",
    async () => {
      const path = `${sandboxProgramsFolder()}${delimiter}${process.env.PATH ?? ""}`;
      // The fake writes this file if it ever gets the key that installs the certificate authority.
      const installed = join(mkdtempSync(join(tmpdir(), "trackwall-ca-")), "installed");
      daemon = await startSessionApi(TOKEN, {
        ...ONE_REPO,
        sandboxTasks: "auto",
        copilot: fakeCopilotWithPath(path, { FAKE_COPILOT_SANDBOX_CA: installed }),
      });
      const { agents } = daemon.facade;
      const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "map the endpoints", approvals: "auto" });
      const session = sessionOf(task.id);

      const asking = await waitFor(agents, session, (s) => s.dialog !== null, "the certificate authority dialog");
      expect(asking.state).toMatchObject({ state: "Approval", source: "screen", reason: "screen sandbox certificate authority dialog" });
      expect(asking.needsAttention).toBe(true);
      expect(asking.dialog).toMatchObject({
        kind: "approval",
        title: "Install the proxy certificate authority?",
        options: [{ key: "2", label: "Continue without installing (Esc)" }],
      });
      const dialog = asking.dialog?.id ?? "";
      expect(() => agents.answerDialog(session, dialog, "1")).toThrow(
        "the dialog has no option 1 that can be answered outside the terminal",
      );

      await daemon.post(agentsApi.answerDialog, { session, dialog, answer: "2" });
      const working = await waitFor(agents, session, (s) => s.state?.source === "hook", "the task's prompt after the answer");
      expect(working.state).toMatchObject({ state: "Working", reason: "hook sessionStart with a prompt" });
      expect(existsSync(installed)).toBe(false);
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test.if(process.platform === "linux")(
    "on Linux without bubblewrap a task that should run in the sandbox is refused before its worktree exists, and the doctor says why",
    async () => {
      const noBwrap = mkdtempSync(join(tmpdir(), "trackwall-empty-path-"));
      daemon = await startSessionApi(TOKEN, { ...ONE_REPO, sandboxTasks: "auto", copilot: fakeCopilotWithPath(noBwrap) });
      const worktreesBefore = existsSync(join(daemon.projects, ".trackwall", "worktrees", "shop"));

      await expect(daemon.post(agentsApi.createTask, { repo: "shop", prompt: "map the endpoints", approvals: "auto" })).rejects.toThrow(
        // `ip` and `iptables` may also be found in /usr/sbin of the runner, so only the start of the list is fixed.
        /this task should run in Copilot CLI's sandbox \(sandbox\.tasks: auto in workspace\.yaml\), but bubblewrap \(bwrap\), slirp4netns.*, which Copilot CLI's sandbox runs on, are not in PATH; install it, or choose "No task" in Settings › Agents › Sandbox$/,
      );
      expect(daemon.facade.agents.sessions().tasks).toEqual([]);
      expect(existsSync(join(daemon.projects, ".trackwall", "worktrees", "shop"))).toBe(worktreesBefore);

      const report = await daemon.post(doctorApi.run, {});
      expect(report.checks.find((c) => c.id === "copilot-sandbox")).toMatchObject({
        status: "fail",
        summary: expect.stringMatching(
          /^Copilot CLI's sandbox cannot run here: bubblewrap \(bwrap\), slirp4netns.*, so Trackwall refuses to start tasks without approvals\.$/,
        ),
      });
    },
    SLOW_TEST_TIMEOUT_MS,
  );
});

describe.if(process.platform === "linux")(
  "Copilot CLI's sandbox in a container (ADR-219, the facade with a real bubblewrap process)",
  () => {
    /** The sandbox's programs, with a `bwrap` that ends with `exitCode`, as bubblewrap does when it cannot make its namespaces. */
    function programsWithBwrap(exitCode: number): string {
      const dir = sandboxProgramsFolder();
      writeFileSync(join(dir, "bwrap"), `#!/bin/sh\necho 'bwrap: No permissions to create new namespace' >&2\nexit ${exitCode}\n`);
      return `${dir}${delimiter}${process.env.PATH ?? ""}`;
    }

    test(
      "where bubblewrap can make its namespaces but a process could become root, the sandbox stays off and the doctor says why",
      async () => {
        // The test runs as root or without no-new-privileges, like a dev container without the guide's flag (ADR-219).
        daemon = await startSessionApi(TOKEN, {
          ...ONE_REPO,
          inContainer: true,
          sandboxTasks: null,
          copilot: fakeCopilotWithPath(programsWithBwrap(0)),
        });
        const { sandbox } = await daemon.post(agentsApi.startOptions, {});
        expect(sandbox).toMatchObject({
          tasks: "off",
          chosen: false,
          problem: expect.stringContaining("could leave it through the /proc/sys"),
        });
        const report = await daemon.post(doctorApi.run, {});
        expect(report.checks.find((c) => c.id === "copilot-sandbox")?.status).toBe("warn");
      },
      SLOW_TEST_TIMEOUT_MS,
    );

    test(
      "where it cannot, tasks run without it as before, and the doctor warns that the container is then their only isolation",
      async () => {
        daemon = await startSessionApi(TOKEN, {
          ...ONE_REPO,
          inContainer: true,
          sandboxTasks: null,
          copilot: fakeCopilotWithPath(programsWithBwrap(1)),
        });
        const problem = "bubblewrap cannot make the sandbox's namespaces here (bwrap: No permissions to create new namespace)";
        expect((await daemon.post(agentsApi.startOptions, {})).sandbox).toEqual({ tasks: "off", problem, chosen: false });
        const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "map the endpoints", approvals: "auto" });
        expect(task.sandbox).toBe(false);

        const report = await daemon.post(doctorApi.run, {});
        expect(report.checks.find((c) => c.id === "copilot-sandbox")).toMatchObject({
          status: "warn",
          summary: `Tasks without approvals run their commands with the container's full access: Copilot CLI's sandbox cannot run in this container (${problem}).`,
        });
      },
      SLOW_TEST_TIMEOUT_MS,
    );
  },
);
