import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/client";
import { agentsApi, ProposeTaskResult, ResumeTaskResult } from "@trackwall/protocol";
import { viewer, waitFor } from "./support/agents.ts";
import { connectSessionClient } from "./support/mcp-client.ts";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const TOKEN = "y".repeat(43);
let daemon: Awaited<ReturnType<typeof startSessionApi>>;
const clients: Client[] = [];

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN);
}, SLOW_TEST_TIMEOUT_MS);

// A limit instead of the default none: a hung cleanup on Windows is to be an error of this file, not an hour of the job.
afterAll(async () => {
  for (const client of clients) await client.close();
  await daemon.stop();
}, 30_000);

async function supervisorClient(): Promise<{ id: string; client: Client }> {
  const supervisor = await daemon.facade.agents.startSupervisor("new", "terminal");
  const client = await connectSessionClient(daemon.api.port, daemon.home, supervisor.id);
  clients.push(client);
  return { id: supervisor.id, client };
}

function sessionOf(task: string): string {
  const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === task && s.run.kind === "running");
  if (!session) throw new Error(`task ${task} has no running session`);
  return session.id;
}

/** The fake Copilot CLI's screen once it printed its arguments, the last one being `--session-id=` or `--resume=`. */
async function argumentsOf(session: string, last: string): Promise<string> {
  const window = viewer(daemon.facade.agents, session);
  await waitFor(daemon.facade.agents, session, () => window.text().includes(`Argument: ${last}`), `${last} on the screen`);
  window.attachment.detach();
  return window.text();
}

async function endTask(task: string, session: string): Promise<void> {
  await waitFor(daemon.facade.agents, session, (s) => s.state !== null, "sessionStart");
  await daemon.facade.agents.stop(session);
  await daemon.post(agentsApi.removeTask, { task, keepBranch: false, discardChanges: true });
}

describe.skipIf(process.versions.bun === undefined)("a task's approvals mode (ADR-105, real PTY and git, fake Copilot CLI)", () => {
  test("a proposal the supervisor marks auto starts its task with --allow-all-tools when the user keeps it, and resuming keeps it", async () => {
    const supervisor = await supervisorClient();
    const { proposal } = ProposeTaskResult.parse(
      (
        await supervisor.client.callTool({
          name: "propose_task",
          arguments: { repo: "shop", title: "Map the endpoints", prompt: "list the HTTP endpoints of shop", approvals: "auto" },
        })
      ).structuredContent,
    );
    expect(proposal.approvals).toBe("auto");

    const task = await daemon.post(agentsApi.approveProposal, {
      proposal: proposal.id,
      prompt: proposal.prompt,
      model: null,
      approvals: "auto",
    });
    expect(task.approvals).toBe("auto");
    const first = sessionOf(task.id);
    expect(await argumentsOf(first, "--session-id=")).toContain("Argument: --allow-all-tools");
    await waitFor(daemon.facade.agents, first, (s) => s.state !== null, "sessionStart");
    await daemon.facade.agents.stop(first);

    const resumed = ResumeTaskResult.parse(
      (await supervisor.client.callTool({ name: "resume_task", arguments: { task: task.id } })).structuredContent,
    );
    expect(resumed.task.approvals).toBe("auto");
    expect(await argumentsOf(resumed.session.id, "--resume=")).toContain("Argument: --allow-all-tools");

    await endTask(task.id, resumed.session.id);
    await daemon.facade.agents.stop(supervisor.id);
  }, 60_000);

  test("a proposal without a mode asks, and an auto proposal the user unticks asks too", async () => {
    const supervisor = await supervisorClient();
    const propose = async (args: Record<string, unknown>) =>
      ProposeTaskResult.parse(
        (
          await supervisor.client.callTool({
            name: "propose_task",
            arguments: { repo: "shop", title: "Fix login", prompt: "fix login", ...args },
          })
        ).structuredContent,
      ).proposal;
    const plain = await propose({});
    expect(plain.approvals).toBe("ask");
    const unticked = await propose({ approvals: "auto" });

    for (const proposal of [plain, unticked]) {
      const task = await daemon.post(agentsApi.approveProposal, {
        proposal: proposal.id,
        prompt: proposal.prompt,
        model: null,
        approvals: "ask",
      });
      expect(task.approvals).toBe("ask");
      const session = sessionOf(task.id);
      expect(await argumentsOf(session, "--session-id=")).not.toContain("--allow-all");
      await endTask(task.id, session);
    }
    await daemon.facade.agents.stop(supervisor.id);
  }, 60_000);

  test("a task the user types with the box ticked runs without approvals, never with --allow-all or --yolo", async () => {
    const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "describe the repo", approvals: "auto" });
    expect(task.approvals).toBe("auto");
    const session = sessionOf(task.id);
    const screen = await argumentsOf(session, "--session-id=");
    const permissionArgs = screen
      .split(/\r?\n/)
      .filter((line) => line.startsWith("Argument: --allow") || line.startsWith("Argument: --yolo"))
      .map((line) => line.trim());
    expect(permissionArgs).toEqual(["Argument: --allow-all-tools"]);
    // A turn, which the fake asks to approve otherwise, ends without an approval dialog.
    const window = viewer(daemon.facade.agents, session);
    window.attachment.input("list the files\r");
    const done = await waitFor(daemon.facade.agents, session, (s) => s.state?.reason === "hook agentStop", "the end of the turn");
    window.attachment.detach();
    expect(done.dialog).toBeNull();
    await endTask(task.id, session);
  }, 60_000);

  test("a mode other than ask or auto is refused before anything is proposed", async () => {
    const supervisor = await supervisorClient();
    const result = await supervisor.client.callTool({
      name: "propose_task",
      arguments: { repo: "shop", title: "Fix login", prompt: "fix login", approvals: "yolo" },
    });
    expect(result.isError).toBe(true);
    expect(daemon.facade.agents.sessions().proposals).toEqual([]);
    await daemon.facade.agents.stop(supervisor.id);
  }, 30_000);
});
