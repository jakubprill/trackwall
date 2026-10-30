import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/client";
import { agentsApi, ProposeTaskResult, ResumeTaskResult, SendMessageResult } from "@trackwall/protocol";
import { viewer, waitFor } from "./support/agents.ts";
import { connectHttpClient, connectSessionClient } from "./support/mcp-client.ts";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const TOKEN = "r".repeat(43);
let daemon: Awaited<ReturnType<typeof startSessionApi>>;
/** An agent outside Trackwall: only the daemon token, no session token. */
let outside: Client;
const clients: Client[] = [];

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN);
  outside = await connectHttpClient(daemon.api.port, TOKEN);
  clients.push(outside);
}, SLOW_TEST_TIMEOUT_MS);

// A limit instead of the default none: a hung cleanup on Windows is to be an error of this file, not an hour of the job.
afterAll(async () => {
  for (const client of clients) await client.close();
  await daemon.stop();
}, 30_000);

async function clientOfSession(session: string): Promise<Client> {
  const client = await connectSessionClient(daemon.api.port, daemon.home, session);
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  return client.callTool({ name, arguments: args });
}

function runningSessionOf(task: string): string {
  const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === task && s.run.kind === "running");
  if (!session) throw new Error(`task ${task} has no running session`);
  return session.id;
}

/** A main session in the repo root, past its `sessionStart`, and its MCP client. */
async function mainSession() {
  const main = await daemon.facade.agents.start("shop");
  await waitFor(daemon.facade.agents, main.id, (s) => s.state?.state === "Input", "sessionStart");
  return { id: main.id, client: await clientOfSession(main.id) };
}

/** A task's session past its `sessionStart`, then stopped, as after its agent exited or Trackwall restarted. */
async function stopSessionOf(task: string): Promise<void> {
  const session = runningSessionOf(task);
  await waitFor(daemon.facade.agents, session, (s) => s.state !== null, "sessionStart");
  await daemon.facade.agents.stop(session);
}

/** The fake's prompt line for a typed prompt: "Thinking about: <prompt>". */
const TYPED_MESSAGE = "Thinking about: The session that proposed your task sent you a message in Trackwall: call get_messages";

describe.skipIf(process.versions.bun === undefined)("resume_task (real PTY and git, fake Copilot CLI)", () => {
  test("the proposer resumes its task in the task's worktree, and the message that waited for it is typed there", async () => {
    const main = await mainSession();
    const { proposal } = ProposeTaskResult.parse(
      (await call(main.client, "propose_task", { repo: "shop", title: "Fix login", prompt: "fix login" })).structuredContent,
    );
    const task = await daemon.post(agentsApi.approveProposal, {
      proposal: proposal.id,
      prompt: "fix login",
      model: null,
      approvals: "ask",
    });
    await stopSessionOf(task.id);
    const sent = SendMessageResult.parse(
      (await call(main.client, "send_message", { task: task.id, text: "Keep the old endpoint." })).structuredContent,
    );
    expect(sent.delivery).toBe("on_resume");

    const resumed = ResumeTaskResult.parse((await call(main.client, "resume_task", { task: task.id })).structuredContent);

    expect(resumed.task).toEqual(task);
    expect(resumed.session).toMatchObject({ repo: "shop", task: task.id, run: { kind: "running" } });
    expect(
      daemon.facade.agents
        .sessions()
        .sessions.filter((s) => s.task === task.id)
        .map((s) => s.id),
    ).toEqual([resumed.session.id]);
    const window = viewer(daemon.facade.agents, resumed.session.id);
    await waitFor(daemon.facade.agents, resumed.session.id, () => window.text().includes(`--resume=${task.id}`), "resume on the screen");
    await waitFor(
      daemon.facade.agents,
      resumed.session.id,
      () => window.unwrappedText().includes(TYPED_MESSAGE),
      "the typed message prompt",
    );
    expect((await call(main.client, "resume_task", { task: task.id })).content).toEqual([
      { type: "text", text: `bad_request: task ${task.branch} has a running session; stop it before resuming` },
    ]);
    const other = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "describe the repo", approvals: "ask" });
    await stopSessionOf(other.id);
    const taskClient = await clientOfSession(resumed.session.id);
    expect((await call(taskClient, "resume_task", { task: other.id })).content).toEqual([
      { type: "text", text: `bad_request: a task session resumes no task; ask the user to resume task ${other.id}` },
    ]);

    window.attachment.detach();
    await daemon.facade.agents.stop(resumed.session.id);
    await daemon.facade.agents.stop(main.id);
    await daemon.post(agentsApi.removeTask, { task: task.id, keepBranch: false, discardChanges: true });
    await daemon.post(agentsApi.removeTask, { task: other.id, keepBranch: false, discardChanges: true });
  }, 60_000);

  test("a main session does not resume a task another main session or the supervisor proposed", async () => {
    const main = await mainSession();
    const neighbour = await mainSession();
    const supervisor = await daemon.facade.agents.startSupervisor("new", "terminal");
    const supervisorClient = await clientOfSession(supervisor.id);
    const proposals = [
      { client: neighbour.client, title: "Fix login" },
      { client: supervisorClient, title: "Fix logout" },
    ];
    const tasks = [];
    for (const { client, title } of proposals) {
      const { proposal } = ProposeTaskResult.parse(
        (await call(client, "propose_task", { repo: "shop", title, prompt: title })).structuredContent,
      );
      const task = await daemon.post(agentsApi.approveProposal, { proposal: proposal.id, prompt: title, model: null, approvals: "ask" });
      await stopSessionOf(task.id);
      tasks.push(task);
    }

    for (const task of tasks)
      expect((await call(main.client, "resume_task", { task: task.id })).content).toEqual([
        { type: "text", text: `bad_request: task ${task.id} was not proposed by this session; ask the user to resume it` },
      ]);

    await daemon.facade.agents.stop(supervisor.id);
    await daemon.facade.agents.stop(neighbour.id);
    await daemon.facade.agents.stop(main.id);
    for (const task of tasks) await daemon.post(agentsApi.removeTask, { task: task.id, keepBranch: false, discardChanges: true });
  }, 60_000);

  test("the supervisor and an agent outside Trackwall resume a task the user started, a main session does not", async () => {
    const main = await mainSession();
    const typed = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "describe the repo", approvals: "ask" });
    await stopSessionOf(typed.id);

    expect((await call(main.client, "resume_task", { task: typed.id })).content).toEqual([
      { type: "text", text: `bad_request: task ${typed.id} was not proposed by this session; ask the user to resume it` },
    ]);
    expect((await call(main.client, "resume_task", { task: "00000000-0000-4000-8000-000000000000" })).isError).toBe(true);

    const supervisor = await daemon.facade.agents.startSupervisor("new", "terminal");
    const bySupervisor = ResumeTaskResult.parse(
      (await call(await clientOfSession(supervisor.id), "resume_task", { task: typed.id })).structuredContent,
    );
    expect(bySupervisor.session).toMatchObject({ task: typed.id, run: { kind: "running" } });
    await stopSessionOf(typed.id);
    const byOutside = ResumeTaskResult.parse((await call(outside, "resume_task", { task: typed.id })).structuredContent);
    expect(byOutside.session).toMatchObject({ task: typed.id, run: { kind: "running" } });

    await stopSessionOf(typed.id);
    await daemon.facade.agents.stop(supervisor.id);
    await daemon.facade.agents.stop(main.id);
    await daemon.post(agentsApi.removeTask, { task: typed.id, keepBranch: false, discardChanges: true });
  }, 60_000);
});
