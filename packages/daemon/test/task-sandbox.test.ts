import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { agentsApi, doctorApi } from "@trackwall/protocol";
import { systemTempFolder, Vcs } from "../src/modules/vcs/vcs.ts";
import { Workspace } from "../src/modules/workspace/workspace.ts";
import { WorkspaceFile } from "../src/modules/workspace/workspace-file.ts";
import { viewer, waitFor } from "./support/agents.ts";
import { fakeHosting } from "./support/hosting.ts";
import { FAKE_COPILOT, ONE_REPO, startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const TOKEN = "s".repeat(43);

/** A folder with an executable `bwrap`, so that on a Linux runner without bubblewrap the daemon sees the sandbox can run. */
function bwrapFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "trackwall-bwrap-"));
  writeFileSync(join(dir, "bwrap"), "#!/bin/sh\n");
  chmodSync(join(dir, "bwrap"), 0o755);
  return dir;
}

/** The fake Copilot CLI with `PATH` as given, which is the `PATH` the daemon checks for bubblewrap. */
function fakeCopilotWithPath(path: string) {
  return { command: FAKE_COPILOT.command, env: () => ({ ...process.env, PATH: path }) };
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

  test("without the key tasks without approvals run in the sandbox, except in a container, and the key wins in both", () => {
    expect(workspace(null, false).sandboxSettings()).toEqual({ tasks: "auto" });
    expect(workspace(null, true).sandboxSettings()).toEqual({ tasks: "off" });
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
      const path = `${bwrapFolder()}${delimiter}${process.env.PATH ?? ""}`;
      daemon = await startSessionApi(TOKEN, { ...ONE_REPO, sandboxTasks: "auto", copilot: fakeCopilotWithPath(path) });
      const options = await daemon.post(agentsApi.startOptions, {});
      expect(options.sandbox).toEqual({ tasks: "auto", problem: null });

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

  test.if(process.platform === "linux")(
    "on Linux without bubblewrap a task that should run in the sandbox is refused before its worktree exists, and the doctor says why",
    async () => {
      const noBwrap = mkdtempSync(join(tmpdir(), "trackwall-empty-path-"));
      daemon = await startSessionApi(TOKEN, { ...ONE_REPO, sandboxTasks: "auto", copilot: fakeCopilotWithPath(noBwrap) });
      const worktreesBefore = existsSync(join(daemon.projects, ".trackwall", "worktrees", "shop"));

      await expect(daemon.post(agentsApi.createTask, { repo: "shop", prompt: "map the endpoints", approvals: "auto" })).rejects.toThrow(
        "this task should run in Copilot CLI's sandbox (sandbox.tasks: auto in workspace.yaml), but bubblewrap (bwrap), which Copilot CLI's sandbox runs on, is not in PATH",
      );
      expect(daemon.facade.agents.sessions().tasks).toEqual([]);
      expect(existsSync(join(daemon.projects, ".trackwall", "worktrees", "shop"))).toBe(worktreesBefore);

      const report = await daemon.post(doctorApi.run, {});
      expect(report.checks.find((c) => c.id === "copilot-sandbox")).toMatchObject({
        status: "fail",
        summary:
          "Copilot CLI's sandbox cannot run here: bubblewrap (bwrap), which Copilot CLI's sandbox runs on, is not in PATH, so Trackwall refuses to start tasks without approvals.",
      });
    },
    SLOW_TEST_TIMEOUT_MS,
  );
});
