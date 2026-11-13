import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { agentsApi, miseApi, servicesApi, terminalsApi } from "@trackwall/protocol";
import { viewer, waitFor } from "./support/agents.ts";
import { connectHttpClient } from "./support/mcp-client.ts";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

// A paused task (ADR-251) through the API the UI calls: real PTY, process groups and git, the fake Copilot CLI and the
// fake mise (`fixtures/fake-mise.ts`), whose `dev` runs `fixtures/fake-service.ts` and whose `watch` runs until stopped.

const TOKEN = "p".repeat(43);
const FAKE_MISE = [process.execPath, join(import.meta.dir, "fixtures", "fake-mise.ts")];
const MISE_CONFIG = JSON.stringify({ tasks: [{ name: "dev" }, { name: "watch" }], servers: { dev: {} } });
const REPOS = { repos: { shop: { "fake-mise.json": MISE_CONFIG } }, miseCommand: FAKE_MISE };
const TIMEOUT = 90_000;

let daemon: Awaited<ReturnType<typeof startSessionApi>>;
/** An agent outside Trackwall with the daemon token, which `resume_task` lets resume any task (ADR-90). */
let outside: Client;

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN, REPOS);
  outside = await connectHttpClient(daemon.api.port, TOKEN);
}, SLOW_TEST_TIMEOUT_MS);

afterAll(async () => {
  await outside.close();
  await daemon.stop();
}, 30_000);

function sessionsOf(api: typeof daemon, task: string) {
  return api.facade.agents.sessions().sessions.filter((s) => s.task === task);
}

function runningSessionOf(api: typeof daemon, task: string): string {
  const session = sessionsOf(api, task).find((s) => s.run.kind === "running");
  if (!session) throw new Error(`task ${task} has no running session`);
  return session.id;
}

async function startService(api: typeof daemon, task: string): Promise<number> {
  const slice = await api.post(servicesApi.start, { repo: "shop", task, lease: false, dependencies: false, waitMs: 30_000 });
  const port = slice.members[0]?.service?.port;
  if (slice.members[0]?.service?.state !== "healthy" || port == null)
    throw new Error(`the task's service did not start: ${JSON.stringify(slice)}`);
  return port;
}

async function taskServiceState(api: typeof daemon, task: string): Promise<string | undefined> {
  return (await api.post(servicesApi.list, {})).find((s) => s.task === task)?.state;
}

async function endTask(api: typeof daemon, task: string): Promise<void> {
  const running = sessionsOf(api, task).find((s) => s.run.kind === "running");
  if (running) await api.post(agentsApi.stop, { session: running.id });
  if ((await taskServiceState(api, task)) === "healthy") await api.post(servicesApi.stop, { repo: "shop", task, dependencies: false });
  await api.post(agentsApi.removeTask, { task, keepBranch: false, discardChanges: true });
}

describe.skipIf(process.versions.bun === undefined)("pausing a task (real PTY, process groups and git, fake Copilot CLI and mise)", () => {
  test(
    "Pause stops the task's session, service, other mise tasks and shell, and keeps its worktree and branch",
    async () => {
      const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "check the orders endpoint", approvals: "auto" });
      const first = runningSessionOf(daemon, task.id);
      const port = await startService(daemon, task.id);
      await daemon.post(miseApi.start, { repo: "shop", task: task.id, miseTask: "watch" });
      await daemon.post(terminalsApi.start, { repo: "shop", task: task.id });
      expect(daemon.facade.procs.liveIn(task.worktree)).toBe(true);

      const paused = await daemon.post(agentsApi.pauseTask, { task: task.id });

      expect(paused.stopped).toEqual(["the session", `the service on port ${port}`, "mise task watch", "the shell"]);
      expect(paused.task.paused).toEqual({ at: expect.any(String), service: { lease: false } });
      // Nothing Trackwall started runs in the worktree any more, and the task's port is free.
      expect(daemon.facade.procs.liveIn(task.worktree)).toBe(false);
      expect(sessionsOf(daemon, task.id).map((s) => [s.id, s.run.kind])).toEqual([[first, "exited"]]);
      expect(await taskServiceState(daemon, task.id)).toBe("stopped");
      expect((await daemon.post(terminalsApi.list, {})).filter((t) => t.task === task.id)).toEqual([]);
      // What the task is stays: the worktree, its branch and the task with its port.
      expect(existsSync(task.worktree)).toBe(true);
      expect(daemon.facade.agents.task(task.id)).toMatchObject({ branch: task.branch, port: task.port, paused: paused.task.paused });
      await endTask(daemon, task.id);
    },
    TIMEOUT,
  );

  test(
    "an agent cannot resume a paused task; the user's Resume goes on with its conversation and starts its service again",
    async () => {
      const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "check the orders endpoint", approvals: "auto" });
      const port = await startService(daemon, task.id);
      await daemon.post(agentsApi.pauseTask, { task: task.id });

      const byAgent = await outside.callTool({ name: "resume_task", arguments: { task: task.id } });
      expect(byAgent.content).toEqual([
        { type: "text", text: `bad_request: task ${task.id} was paused by the user; ask the user to resume it` },
      ]);
      expect(sessionsOf(daemon, task.id).every((s) => s.run.kind === "exited")).toBe(true);

      const resumed = await daemon.post(agentsApi.resumeTask, { task: task.id });

      expect(resumed.paused).toBeNull();
      const session = runningSessionOf(daemon, task.id);
      const window = viewer(daemon.facade.agents, session);
      await waitFor(daemon.facade.agents, session, () => window.text().includes(`--resume=${task.id}`), "the resume on the screen");
      window.attachment.detach();
      const service = await waitForService(daemon, task.id);
      expect(service).toMatchObject({ state: "healthy", port, lease: false });
      await endTask(daemon, task.id);
    },
    TIMEOUT,
  );

  test(
    "a task paused with nothing running is paused all the same, and a second pause keeps the first one's time and service",
    async () => {
      const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "describe the repo", approvals: "auto" });
      await startService(daemon, task.id);
      const first = await daemon.post(agentsApi.pauseTask, { task: task.id });

      const again = await daemon.post(agentsApi.pauseTask, { task: task.id });

      expect(again.stopped).toEqual([]);
      expect(again.task.paused).toEqual(first.task.paused);
      await endTask(daemon, task.id);
    },
    TIMEOUT,
  );

  test(
    "a paused task stays paused across a daemon restart: its session is not resumed, and only the user's Resume goes on",
    async () => {
      const before = await startSessionApi("q".repeat(43), REPOS);
      let after: Awaited<ReturnType<typeof startSessionApi>> | undefined;
      try {
        const task = await before.post(agentsApi.createTask, { repo: "shop", prompt: "describe the repo", approvals: "auto" });
        // A second task runs through the restart, so the restart is seen resuming what it should.
        const running = await before.post(agentsApi.createTask, { repo: "shop", prompt: "describe the tests", approvals: "auto" });
        runningSessionOf(before, running.id);
        const paused = await before.post(agentsApi.pauseTask, { task: task.id });
        await before.stop();

        after = await startSessionApi("q".repeat(43), { ...REPOS, restartOf: { home: before.home, projects: before.projects } });
        const restarted = after;
        await waitForCondition(() => sessionsOf(restarted, running.id).some((s) => s.run.kind === "running"), "the running task resumed");

        expect(after.facade.agents.task(task.id).paused).toEqual(paused.task.paused);
        expect(sessionsOf(after, task.id)).toEqual([]);
        const agent = await connectHttpClient(after.api.port, "q".repeat(43));
        const byAgent = await agent.callTool({ name: "resume_task", arguments: { task: task.id } });
        await agent.close();
        expect(byAgent.content).toEqual([
          { type: "text", text: `bad_request: task ${task.id} was paused by the user; ask the user to resume it` },
        ]);

        const resumed = await after.post(agentsApi.resumeTask, { task: task.id });
        expect(resumed.paused).toBeNull();
        runningSessionOf(after, task.id);
        await endTask(after, task.id);
        await endTask(after, running.id);
      } finally {
        await after?.stop();
      }
    },
    TIMEOUT,
  );
});

async function waitForService(api: typeof daemon, task: string) {
  let last: unknown;
  for (let i = 0; i < 300; i++) {
    const service = (await api.post(servicesApi.list, {})).find((s) => s.task === task);
    last = service;
    if (service?.state === "healthy") return service;
    await Bun.sleep(100);
  }
  throw new Error(`the task's service did not start again: ${JSON.stringify(last)}`);
}

async function waitForCondition(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (condition()) return;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}
