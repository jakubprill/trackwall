import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { agentsApi, ProposeTaskResult, type Task } from "@trackwall/protocol";
import { viewer, waitFor } from "./support/agents.ts";
import { commitFiles, gitIn } from "./support/git-repo.ts";
import { connectSessionClient } from "./support/mcp-client.ts";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const TOKEN = "r".repeat(43);
let daemon: Awaited<ReturnType<typeof startSessionApi>>;
const clients: Client[] = [];

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN);
  // Round commits (ADR-168) carry the user's own identity, which git takes from the repo's config here.
  gitIn(join(daemon.projects, "shop"), "config", "user.name", "Repo User");
  gitIn(join(daemon.projects, "shop"), "config", "user.email", "user@example.com");
}, SLOW_TEST_TIMEOUT_MS);

afterAll(async () => {
  for (const client of clients) await client.close();
  await daemon.stop();
}, 30_000);

async function clientOf(session: string): Promise<Client> {
  const client = await connectSessionClient(daemon.api.port, daemon.home, session);
  clients.push(client);
  return client;
}

function runningSession(task: string): string {
  const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === task && s.run.kind === "running");
  if (!session) throw new Error(`task ${task} has no running session`);
  return session.id;
}

/** The user starts a turn of the task's session: the fake asks for an approval, and the turn waits for it. */
async function startTurn(session: string): Promise<void> {
  viewer(daemon.facade.agents, session).attachment.input("go on\r");
  await approvalAsked(session);
}

async function approvalAsked(session: string): Promise<void> {
  await waitFor(daemon.facade.agents, session, (s) => s.state?.state === "Approval", "the approval");
}

/** The approval ends the turn; `then` is the state the session is in after it. */
async function approve(session: string, then: "Approval" | "Input"): Promise<void> {
  const window = viewer(daemon.facade.agents, session);
  window.attachment.input("1");
  await waitFor(daemon.facade.agents, session, (s) => s.state?.state === then, `${then} after the approval`);
  window.attachment.detach();
}

/** Waits until `check` holds, up to 20 s. */
async function eventually(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
  const until = Date.now() + 20_000;
  while (!(await check())) {
    if (Date.now() > until) throw new Error(`gave up waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * As in a run seen on a real model: a task proposed by a main session reports its result in the middle of a turn, and its
 * proposer's message comes before that turn ends, so the daemon's prompt to read it starts the next turn (which waits for
 * its approval when this returns).
 */
async function reportedThenMessaged(): Promise<{ main: string; task: Task; session: string }> {
  const main = (await daemon.facade.agents.start("shop")).id;
  const proposer = await clientOf(main);
  const { proposal } = ProposeTaskResult.parse(
    (await proposer.callTool({ name: "propose_task", arguments: { repo: "shop", title: "Fix login", prompt: "fix login" } }))
      .structuredContent,
  );
  const task = await daemon.post(agentsApi.approveProposal, { proposal: proposal.id, prompt: "fix login", model: null, approvals: "ask" });
  const session = runningSession(task.id);
  await startTurn(session);
  commitFiles(task.worktree, { "LOGIN.md": "login works\n" }, "Fix login");
  await (await clientOf(session)).callTool({ name: "report_result", arguments: { summary: "Login fixed." } });
  expect(daemon.facade.agents.task(task.id).inReview).toBe(true);
  await proposer.callTool({ name: "send_message", arguments: { task: task.id, text: "Is the locked account covered too?" } });
  expect(daemon.facade.agents.task(task.id).inReview).toBe(false);
  await approve(session, "Approval");
  // The reporting turn's round, which the end of a turn that changed nothing must not count.
  await eventually(async () => (await daemon.facade.agents.taskRounds(task.id)).rounds.length === 1, "the round of the reporting turn");
  return { main, task, session };
}

async function end(main: string, task: Task, session: string): Promise<void> {
  for (const s of [session, main]) await daemon.facade.agents.stop(s);
  await daemon.post(agentsApi.removeTask, { task: task.id, keepBranch: false, discardChanges: true });
}

describe.skipIf(process.versions.bun === undefined)(
  "a task given work again after its report goes back to review when its next turn changes nothing (ADR-258; real PTY and git, fake Copilot CLI)",
  () => {
    test("the agent answers its proposer's message without changing a file: the task is in review again", async () => {
      const { main, task, session } = await reportedThenMessaged();
      // The turn the reporting turn was still in when the message came does not count: the agent had not read it yet.
      expect(daemon.facade.agents.task(task.id).inReview).toBe(false);

      await approve(session, "Input");

      await eventually(() => daemon.facade.agents.task(task.id).inReview, "the task back in review");
      await end(main, task, session);
    }, 60_000);

    test("the agent changes a file after its proposer's message: the task stays at work until it reports again", async () => {
      const { main, task, session } = await reportedThenMessaged();

      commitFiles(task.worktree, { "LOCKED.md": "locked accounts are refused\n" }, "Cover locked accounts");
      await approve(session, "Input");

      await eventually(async () => (await daemon.facade.agents.taskRounds(task.id)).rounds.length === 2, "the round of the answer");
      await new Promise((r) => setTimeout(r, 300));
      expect(daemon.facade.agents.task(task.id).inReview).toBe(false);
      await end(main, task, session);
    }, 60_000);
  },
);
