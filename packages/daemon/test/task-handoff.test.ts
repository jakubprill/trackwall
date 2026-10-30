import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { agentsApi, ProposeTaskResult } from "@trackwall/protocol";
import { sessionDir } from "../src/modules/agents/session-launcher.ts";
import { waitFor } from "./support/agents.ts";
import { commitFiles, gitIn } from "./support/git-repo.ts";
import { connectSessionClient } from "./support/mcp-client.ts";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const TOKEN = "h".repeat(43);
let daemon: Awaited<ReturnType<typeof startSessionApi>>;
const clients: Client[] = [];

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN, {
    repos: { payments: { "README.md": "# payments\n" }, "orders-api": { "README.md": "# orders-api\n" } },
    miseCommand: ["mise"],
  });
}, SLOW_TEST_TIMEOUT_MS);

afterAll(async () => {
  for (const client of clients) await client.close();
  await daemon.stop();
}, 30_000);

async function clientOfSession(session: string): Promise<Client> {
  const client = await connectSessionClient(daemon.api.port, daemon.home, session);
  clients.push(client);
  return client;
}

async function proposeTask(client: Client, repo: string, title: string) {
  const result = await client.callTool({ name: "propose_task", arguments: { repo, title, prompt: title } });
  return ProposeTaskResult.parse(result.structuredContent).proposal;
}

async function approve(proposal: string, prompt: string) {
  return daemon.post(agentsApi.approveProposal, { proposal, prompt, model: null, approvals: "ask" });
}

function runningSession(task: string): string {
  const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === task && s.run.kind === "running");
  if (!session) throw new Error(`task ${task} has no running session`);
  return session.id;
}

function instructionsOf(session: string): string {
  return readFileSync(join(sessionDir(daemon.home, session), "instructions", "trackwall.instructions.md"), "utf8");
}

describe.skipIf(process.versions.bun === undefined)(
  "a task handed its work by another task (ADR-143; real PTY and git, fake Copilot CLI)",
  () => {
    test("the subtask's session is told which task handed it the work, its branch and the commit it was at, and later that the task ended", async () => {
      const main = await daemon.facade.agents.start("payments");
      await waitFor(daemon.facade.agents, main.id, (s) => s.state?.state === "Input", "sessionStart");
      const mainClient = await clientOfSession(main.id);
      const parent = await approve((await proposeTask(mainClient, "payments", "Retry failed payments")).id, "retry failed payments");
      const parentSession = runningSession(parent.id);
      // A task the main session proposed was handed nothing by a task.
      expect(instructionsOf(parentSession)).not.toContain("Your task was handed to you by");

      commitFiles(parent.worktree, { "openapi.yaml": "paths:\n  /api/payments/{id}/retry:\n    post: {}\n" }, "Add the retry endpoint");
      const parentHead = gitIn(parent.worktree, "rev-parse", "HEAD").trim();
      const childProposal = await proposeTask(await clientOfSession(parentSession), "orders-api", "Retry through the new endpoint");
      const child = await approve(childProposal.id, "retry through the new endpoint");
      const childSession = runningSession(child.id);

      expect(instructionsOf(childSession)).toContain(
        `- Your task was handed to you by the task \`${parent.id}\` in the repo \`payments\` (branch \`${parent.branch}\`): its session proposed your task, and the user approved it when that branch was at commit \`${parentHead}\`. This worktree was made from the default branch, not from that branch, so it does not have that change. Before you change code that builds on it, read what it changed with get_task_changes and task \`${parent.id}\``,
      );
      expect(instructionsOf(childSession)).toContain(
        `- A question about that change goes into your report_result: the session of task \`${parent.id}\` reads your result.`,
      );

      // The user ends the handing task; the subtask's next session is told it can no longer read it.
      await daemon.facade.agents.stop(childSession);
      await daemon.facade.agents.stop(parentSession);
      await daemon.post(agentsApi.removeTask, { task: parent.id, keepBranch: true, discardChanges: true });
      await daemon.post(agentsApi.resumeTask, { task: child.id });
      const resumed = runningSession(child.id);
      expect(instructionsOf(resumed)).toContain(
        `- Your task was handed to you by the task \`${parent.id}\` in the repo \`payments\` (branch \`${parent.branch}\`), which the user has ended since, so get_task_changes no longer reads it.`,
      );

      for (const session of [resumed, main.id]) await daemon.facade.agents.stop(session);
      await daemon.post(agentsApi.removeTask, { task: child.id, keepBranch: false, discardChanges: true });
    }, 60_000);
  },
);
