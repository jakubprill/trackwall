import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { agentsApi, modelSwitch } from "@trackwall/protocol";
import { viewer, waitFor } from "./support/agents.ts";
import { FAKE_COPILOT, ONE_REPO, startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

// Another model for a running session or a task (ADR-206): a restart or a Resume on it, through the API the UI calls.

const TOKEN = "c".repeat(43);
let daemon: Awaited<ReturnType<typeof startSessionApi>>;

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN);
}, SLOW_TEST_TIMEOUT_MS);

afterAll(async () => {
  await daemon.stop();
}, 30_000);

function runningSessionOf(task: string): string {
  const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === task && s.run.kind === "running");
  if (!session) throw new Error(`task ${task} has no running session`);
  return session.id;
}

/** The fake Copilot CLI's screen once it printed its arguments, the last one starting with `last`. */
async function argumentsOf(session: string, last: string): Promise<string> {
  const window = viewer(daemon.facade.agents, session);
  await waitFor(daemon.facade.agents, session, () => window.text().includes(`Argument: ${last}`), `${last} on the screen`);
  window.attachment.detach();
  return window.text();
}

async function started(session: string): Promise<void> {
  await waitFor(daemon.facade.agents, session, (s) => s.state !== null, "sessionStart");
}

describe.skipIf(process.versions.bun === undefined)("another model for a session or a task (real PTY and git, fake Copilot CLI)", () => {
  test("a restart on another model resumes the task's conversation on it, and the task keeps it for its next Resume", async () => {
    const task = await daemon.post(agentsApi.createTask, {
      repo: "shop",
      prompt: "describe the repo",
      approvals: "ask",
      model: "claude-sonnet-4.5",
    });
    const first = runningSessionOf(task.id);
    await argumentsOf(first, "--session-id=");
    await started(first);

    const restarted = await daemon.post(agentsApi.restart, { session: first, model: "claude-sonnet-5.5" });

    expect(restarted.model).toBe("claude-sonnet-5.5");
    const screen = await argumentsOf(restarted.id, "--resume=");
    expect(screen).toContain("Argument: --model=claude-sonnet-5.5");
    expect(screen).not.toContain("--model=claude-sonnet-4.5");
    expect(daemon.facade.agents.task(task.id).model).toBe("claude-sonnet-5.5");
    await started(restarted.id);
    await daemon.post(agentsApi.stop, { session: restarted.id });

    const resumed = await daemon.post(agentsApi.resumeTask, { task: task.id });
    expect(resumed.model).toBe("claude-sonnet-5.5");
    expect(await argumentsOf(runningSessionOf(task.id), "--resume=")).toContain("Argument: --model=claude-sonnet-5.5");

    await daemon.post(agentsApi.stop, { session: runningSessionOf(task.id) });
    await daemon.post(agentsApi.removeTask, { task: task.id, keepBranch: false, discardChanges: true });
  }, 60_000);

  test("Resume of a stopped task with the model cleared runs it on Copilot CLI's default from then on", async () => {
    const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "describe the repo", approvals: "ask", model: "gpt-5.5" });
    const first = runningSessionOf(task.id);
    await started(first);
    await daemon.post(agentsApi.stop, { session: first });

    const resumed = await daemon.post(agentsApi.resumeTask, { task: task.id, model: null });

    expect(resumed.model).toBeNull();
    expect(await argumentsOf(runningSessionOf(task.id), "--resume=")).not.toContain("--model=");
    expect(daemon.facade.agents.session(runningSessionOf(task.id)).model).toBeNull();
    await daemon.post(agentsApi.stop, { session: runningSessionOf(task.id) });
    await daemon.post(agentsApi.removeTask, { task: task.id, keepBranch: false, discardChanges: true });
  }, 60_000);

  test("a repo session restarted on another model keeps it for its next plain restart", async () => {
    const session = await daemon.post(agentsApi.start, { repo: "shop", prompt: "explain the build", model: "gpt-5.5" });
    expect(session.model).toBe("gpt-5.5");
    await started(session.id);

    await daemon.post(agentsApi.restart, { session: session.id, model: "claude-opus-5.5" });
    expect(await argumentsOf(session.id, "--resume=")).toContain("Argument: --model=claude-opus-5.5");
    await started(session.id);
    await daemon.post(agentsApi.restart, { session: session.id });

    const screen = await argumentsOf(session.id, "--resume=");
    expect(screen).toContain("Argument: --model=claude-opus-5.5");
    expect(screen).not.toContain("--model=gpt-5.5");
    await daemon.post(agentsApi.stop, { session: session.id });
  }, 60_000);

  test("the supervisor restarted on another model saves it as its model in Settings, so its next start keeps it", async () => {
    const supervisor = await daemon.facade.agents.startSupervisor("new", "terminal");
    await started(supervisor.id);

    const restarted = await daemon.post(agentsApi.restart, { session: supervisor.id, model: "gpt-5-mini" });

    expect(restarted.model).toBe("gpt-5-mini");
    expect(await argumentsOf(restarted.id, "--session-id=")).toContain("Argument: --model=gpt-5-mini");
    expect(daemon.facade.workspace.supervisorModel()).toBe("gpt-5-mini");
    await daemon.post(agentsApi.stop, { session: restarted.id });
  }, 60_000);

  test("a task asked for a model the account does not offer shows the one Copilot CLI before 1.0.109 took instead, and a restart on an offered model clears the switch (ADR-225)", async () => {
    // The fake falls back to the account's first model as Copilot CLI did before 1.0.109 (no error, the turn runs) and
    // writes its receipts to the event log in its own home, like Copilot CLI.
    const account = await startSessionApi("d".repeat(43), {
      ...ONE_REPO,
      copilot: {
        command: FAKE_COPILOT.command,
        env: ({ home }) => ({
          ...process.env,
          COPILOT_HOME: join(home, "copilot-home"),
          FAKE_COPILOT_ACCOUNT_MODELS: "gpt-6-luna,claude-opus-5.5",
          FAKE_COPILOT_FALLBACK: "1",
        }),
      },
    });
    try {
      const { agents } = account.facade;
      const task = await account.post(agentsApi.createTask, {
        repo: "shop",
        prompt: "describe the repo",
        approvals: "auto",
        model: "claude-sonnet-5.5",
      });
      const session = agents.sessions().sessions.find((s) => s.task === task.id);
      if (session === undefined) throw new Error("the task started no session");

      const switched = await waitFor(agents, session.id, (s) => s.modelInUse !== null, "the model in use", 30_000);

      expect(switched.model).toBe("claude-sonnet-5.5");
      expect(switched.modelInUse).toBe("gpt-6-luna");
      expect(modelSwitch(switched)).toEqual({ requested: "claude-sonnet-5.5", inUse: "gpt-6-luna" });
      // The task's conversation is under the task's id, not the session's, and its usage comes from there too (ADR-190).
      expect(switched.usage).toMatchObject({ modelCalls: 1 });

      // The old receipts in the log name gpt-6-luna, which must not count against the new model.
      const restarted = await account.post(agentsApi.restart, { session: session.id, model: "claude-opus-5.5" });
      expect(restarted.model).toBe("claude-opus-5.5");
      expect(modelSwitch(restarted)).toBeNull();
      const resumed = await waitFor(agents, restarted.id, (s) => s.modelInUse !== null, "the model set at the resume", 30_000);
      expect(resumed.modelInUse).toBe("claude-opus-5.5");
      await account.post(agentsApi.stop, { session: restarted.id });
    } finally {
      await account.stop();
    }
  }, 60_000);

  test("a task on a model the account does not offer shows why its model call failed, and a restart on an offered model clears it (ADR-242)", async () => {
    // As Copilot CLI 1.0.109 does: the session starts on the requested model, and every prompt fails with an error in the
    // event log and no receipt, instead of a fallback.
    const account = await startSessionApi("e".repeat(43), {
      ...ONE_REPO,
      copilot: {
        command: FAKE_COPILOT.command,
        env: ({ home }) => ({
          ...process.env,
          COPILOT_HOME: join(home, "copilot-home"),
          FAKE_COPILOT_ACCOUNT_MODELS: "gpt-6-luna,claude-opus-5.5",
        }),
      },
    });
    try {
      const { agents } = account.facade;
      const task = await account.post(agentsApi.createTask, {
        repo: "shop",
        prompt: "describe the repo",
        approvals: "auto",
        model: "claude-sonnet-5.5",
      });
      const session = agents.sessions().sessions.find((s) => s.task === task.id);
      if (session === undefined) throw new Error("the task started no session");

      const failed = await waitFor(agents, session.id, (s) => s.modelError !== null, "the failed model call", 30_000);

      expect(failed.modelError).toBe('Execution failed: Model "claude-sonnet-5.5" is not available.');
      expect(failed.modelInUse).toBe("claude-sonnet-5.5");
      expect(modelSwitch(failed)).toBeNull();
      expect(failed.usage).toBeNull();

      const restarted = await account.post(agentsApi.restart, { session: session.id, model: "claude-opus-5.5" });
      expect(restarted.modelError).toBeNull();
      const resumed = await waitFor(agents, restarted.id, (s) => s.modelInUse === "claude-opus-5.5", "the model set at the resume", 30_000);
      expect(resumed.modelError).toBeNull();
      await account.post(agentsApi.stop, { session: restarted.id });
    } finally {
      await account.stop();
    }
  }, 60_000);
});
