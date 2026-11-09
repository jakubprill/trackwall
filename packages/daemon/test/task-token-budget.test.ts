import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { agentsApi, workspaceApi } from "@trackwall/protocol";
import { viewer, waitFor } from "./support/agents.ts";
import { connectHttpClient } from "./support/mcp-client.ts";
import { FAKE_COPILOT, ONE_REPO, startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

// A task's token budget (ADR-237) through the API the UI calls. Every model call of the fake Copilot CLI writes a
// receipt of 100 input and 20 output tokens to the conversation's event log in its home, as Copilot CLI does (ADR-190):
// one for the prompt the task starts with, one for every prompt typed after it. Tasks run without approvals, so a turn
// ends without an answer from the test.

const TOKEN = "t".repeat(43);
let daemon: Awaited<ReturnType<typeof startSessionApi>>;
/** An agent outside Trackwall: only the daemon token, which `resume_task` lets resume any task (ADR-90). */
let outside: Client;

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN, {
    ...ONE_REPO,
    copilot: { command: FAKE_COPILOT.command, env: ({ home }) => ({ ...process.env, COPILOT_HOME: join(home, "copilot-home") }) },
  });
  outside = await connectHttpClient(daemon.api.port, TOKEN);
}, SLOW_TEST_TIMEOUT_MS);

afterAll(async () => {
  await outside.close();
  await daemon.stop();
}, 30_000);

function newestSessionOf(task: string): string {
  const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === task);
  if (!session) throw new Error(`task ${task} has no session`);
  return session.id;
}

/** Types a prompt into the session's terminal; the fake takes it as a new model call. */
function typePrompt(session: string, prompt: string): void {
  const window = viewer(daemon.facade.agents, session);
  window.attachment.input(`${prompt}\r`);
  window.attachment.detach();
}

async function removeTask(task: string): Promise<void> {
  const running = daemon.facade.agents.sessions().sessions.find((s) => s.task === task && s.run.kind === "running");
  if (running) await daemon.post(agentsApi.stop, { session: running.id });
  await daemon.post(agentsApi.removeTask, { task, keepBranch: false, discardChanges: true });
}

describe.skipIf(process.versions.bun === undefined)("a task's token budget (real PTY and git, fake Copilot CLI)", () => {
  test("without a budget a task goes on using tokens past any amount: nothing stops it", async () => {
    await daemon.post(workspaceApi.setTaskTokenBudget, { budget: null });
    const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "describe the repo", approvals: "auto" });
    const session = newestSessionOf(task.id);
    await waitFor(daemon.facade.agents, session, (s) => s.usage?.modelCalls === 1, "the first model call");

    typePrompt(session, "and the tests");
    const used = await waitFor(daemon.facade.agents, session, (s) => s.usage?.modelCalls === 2, "the second model call");

    expect(used.usage).toMatchObject({ inputTokens: 200, outputTokens: 40 });
    expect(used.tokenBudget).toBeNull();
    expect(used.run.kind).toBe("running");
    await removeTask(task.id);
  }, 60_000);

  test("a task that reaches its budget is stopped, and a Resume gives it the budget again for what it uses from then on", async () => {
    await daemon.post(workspaceApi.setTaskTokenBudget, { budget: 200 });
    const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "describe the repo", approvals: "auto" });
    const first = newestSessionOf(task.id);
    const underBudget = await waitFor(daemon.facade.agents, first, (s) => s.usage?.modelCalls === 1, "the first model call");
    expect(underBudget.tokenBudget).toEqual({ budget: 200, used: 120, reached: false });
    expect(underBudget.run.kind).toBe("running");

    typePrompt(first, "and the tests");
    const stopped = await waitFor(daemon.facade.agents, first, (s) => s.run.kind === "exited", "the stop at the budget");

    expect(stopped.tokenBudget).toEqual({ budget: 200, used: 240, reached: true });
    expect(stopped.usage).toMatchObject({ modelCalls: 2, inputTokens: 200, outputTokens: 40 });

    // An agent cannot lift the budget by resuming the task: only the user's Resume gives it the budget again.
    const byAgent = await outside.callTool({ name: "resume_task", arguments: { task: task.id } });
    expect(byAgent.content).toEqual([
      { type: "text", text: `bad_request: task ${task.id} was stopped at its token budget; ask the user to resume it` },
    ]);

    await daemon.post(agentsApi.resumeTask, { task: task.id });
    const resumed = newestSessionOf(task.id);
    const afterResume = await waitFor(daemon.facade.agents, resumed, (s) => s.state !== null, "the resumed session's start");
    // The conversation's total goes on, the budget counts only what this start uses.
    expect(afterResume.usage).toMatchObject({ modelCalls: 2 });
    expect(afterResume.tokenBudget).toEqual({ budget: 200, used: 0, reached: false });
    expect(afterResume.run.kind).toBe("running");
    await removeTask(task.id);
  }, 60_000);

  test("a session in a repo, not a task's, has no budget even when tasks have one", async () => {
    await daemon.post(workspaceApi.setTaskTokenBudget, { budget: 100 });
    const session = await daemon.post(agentsApi.start, { repo: "shop", prompt: "explain the build" });
    const used = await waitFor(daemon.facade.agents, session.id, (s) => s.usage?.modelCalls === 1, "the first model call");

    expect(used.tokenBudget).toBeNull();
    expect(used.run.kind).toBe("running");
    await daemon.post(agentsApi.stop, { session: session.id });
  }, 60_000);

  test("a task in the conversation view is stopped at its budget too, and its Resume counts from the loaded conversation", async () => {
    await daemon.post(workspaceApi.setTaskTokenBudget, { budget: 100 });
    const task = await daemon.post(agentsApi.createTask, {
      repo: "shop",
      prompt: "describe the repo",
      approvals: "auto",
      view: "conversation",
    });
    const session = newestSessionOf(task.id);

    const stopped = await waitFor(daemon.facade.agents, session, (s) => s.run.kind === "exited", "the stop at the budget", 30_000);
    expect(stopped.tokenBudget).toEqual({ budget: 100, used: 120, reached: true });

    await daemon.post(agentsApi.resumeTask, { task: task.id });
    const resumed = newestSessionOf(task.id);
    const afterResume = await waitFor(daemon.facade.agents, resumed, (s) => s.usage !== null, "the loaded conversation's usage");
    expect(afterResume.tokenBudget).toEqual({ budget: 100, used: 0, reached: false });
    expect(afterResume.run.kind).toBe("running");
    await removeTask(task.id);
  }, 60_000);

  test("an agent cannot resume a task stopped at its budget after a daemon restart either", async () => {
    const before = await startSessionApi("u".repeat(43), {
      ...ONE_REPO,
      copilot: { command: FAKE_COPILOT.command, env: ({ home }) => ({ ...process.env, COPILOT_HOME: join(home, "copilot-home") }) },
    });
    let after: Awaited<ReturnType<typeof startSessionApi>> | undefined;
    try {
      await before.post(workspaceApi.setTaskTokenBudget, { budget: 100 });
      const task = await before.post(agentsApi.createTask, { repo: "shop", prompt: "describe the repo", approvals: "auto" });
      const first = before.facade.agents.sessions().sessions.find((s) => s.task === task.id);
      if (first === undefined) throw new Error("the task started no session");
      await waitFor(before.facade.agents, first.id, (s) => s.run.kind === "exited", "the stop at the budget");
      await before.stop();

      after = await startSessionApi("u".repeat(43), {
        ...ONE_REPO,
        restartOf: { home: before.home, projects: before.projects },
        copilot: { command: FAKE_COPILOT.command, env: ({ home }) => ({ ...process.env, COPILOT_HOME: join(home, "copilot-home") }) },
      });
      const agent = await connectHttpClient(after.api.port, "u".repeat(43));
      const byAgent = await agent.callTool({ name: "resume_task", arguments: { task: task.id } });
      await agent.close();

      expect(byAgent.content).toEqual([
        { type: "text", text: `bad_request: task ${task.id} was stopped at its token budget; ask the user to resume it` },
      ]);
    } finally {
      await after?.stop();
    }
  }, 60_000);

  test("Settings saves the budget to workspace.yaml and shows it, and clearing it removes the key", async () => {
    const saved = await daemon.post(workspaceApi.setTaskTokenBudget, { budget: 2_000_000 });
    expect(saved).toMatchObject({ taskTokenBudget: 2_000_000, taskTokenBudgetProblem: null });

    const cleared = await daemon.post(workspaceApi.setTaskTokenBudget, { budget: null });
    expect(cleared).toMatchObject({ taskTokenBudget: null, taskTokenBudgetProblem: null });
  });
});
