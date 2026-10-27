import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/client";
import { agentsApi, ProposeTaskResult, ResumeTaskResult } from "@trackwall/protocol";
import { viewer, waitFor } from "./support/agents.ts";
import { connectSessionClient } from "./support/mcp-client.ts";
import { startSessionApi } from "./support/session-api.ts";

const TOKEN = "m".repeat(43);
let daemon: Awaited<ReturnType<typeof startSessionApi>>;
const clients: Client[] = [];

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN);
});

// A limit instead of the default none: a hung cleanup on Windows is to be an error of this file, not an hour of the job.
afterAll(async () => {
  for (const client of clients) await client.close();
  await daemon.stop();
}, 30_000);

async function supervisorClient(): Promise<{ id: string; client: Client }> {
  const supervisor = await daemon.facade.agents.startSupervisor("new");
  const client = await connectSessionClient(daemon.api.port, TOKEN, daemon.home, supervisor.id);
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

describe.skipIf(process.versions.bun === undefined)("the model of a proposed task (ADR-98, real PTY and git, fake Copilot CLI)", () => {
  test("the model the supervisor proposes starts the task's session on it, and resuming the task keeps it", async () => {
    const supervisor = await supervisorClient();
    const { proposal } = ProposeTaskResult.parse(
      (
        await supervisor.client.callTool({
          name: "propose_task",
          arguments: { repo: "shop", title: "Review login", prompt: "review the login change", model: "claude-opus-5.5" },
        })
      ).structuredContent,
    );
    expect(proposal.model).toBe("claude-opus-5.5");

    const task = await daemon.post(agentsApi.approveProposal, { proposal: proposal.id, prompt: proposal.prompt, model: proposal.model });
    expect(task.model).toBe("claude-opus-5.5");
    const first = sessionOf(task.id);
    expect(await argumentsOf(first, "--session-id=")).toContain("Argument: --model=claude-opus-5.5");
    await waitFor(daemon.facade.agents, first, (s) => s.state !== null, "sessionStart");
    await daemon.facade.agents.stop(first);

    const resumed = ResumeTaskResult.parse(
      (await supervisor.client.callTool({ name: "resume_task", arguments: { task: task.id } })).structuredContent,
    );
    expect(resumed.task.model).toBe("claude-opus-5.5");
    expect(await argumentsOf(resumed.session.id, "--resume=")).toContain("Argument: --model=claude-opus-5.5");

    await daemon.facade.agents.stop(resumed.session.id);
    await daemon.facade.agents.stop(supervisor.id);
    await daemon.post(agentsApi.removeTask, { task: task.id, keepBranch: false, discardChanges: true });
  }, 60_000);

  test("without a model, or with the proposed one cleared by the user, the task runs on Copilot CLI's default", async () => {
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
    expect(plain.model).toBeNull();
    const cleared = await propose({ model: "gpt-5.5" });

    for (const proposal of [plain, cleared]) {
      const task = await daemon.post(agentsApi.approveProposal, { proposal: proposal.id, prompt: proposal.prompt, model: null });
      expect(task.model).toBeNull();
      const session = sessionOf(task.id);
      expect(await argumentsOf(session, "--session-id=")).not.toContain("--model=");
      await waitFor(daemon.facade.agents, session, (s) => s.state !== null, "sessionStart");
      await daemon.facade.agents.stop(session);
      await daemon.post(agentsApi.removeTask, { task: task.id, keepBranch: false, discardChanges: true });
    }
    await daemon.facade.agents.stop(supervisor.id);
  }, 60_000);

  test("a model that is not an id is refused before anything is proposed, so it never reaches Copilot CLI as an option", async () => {
    const supervisor = await supervisorClient();
    for (const model of ["opus 5.5", "--yolo"]) {
      const result = await supervisor.client.callTool({
        name: "propose_task",
        arguments: { repo: "shop", title: "Fix login", prompt: "fix login", model },
      });
      expect(result.isError).toBe(true);
    }
    expect(daemon.facade.agents.sessions().proposals).toEqual([]);
    await daemon.facade.agents.stop(supervisor.id);
  }, 30_000);
});
