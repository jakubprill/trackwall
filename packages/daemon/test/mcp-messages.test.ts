import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { agentsApi, GetMessagesResult, GetUpdatesResult, ProposeTaskResult, SendMessageResult } from "@trackwall/protocol";
import { SESSION_TOKEN_HEADER } from "../src/mcp/endpoint.ts";
import { viewer, waitFor } from "./support/agents.ts";
import { connectHttpClient } from "./support/mcp-client.ts";
import { startSessionApi } from "./support/session-api.ts";

const TOKEN = "m".repeat(43);
let daemon: Awaited<ReturnType<typeof startSessionApi>>;
/** An agent outside Trackwall: only the daemon token, no session token. */
let outside: Client;
const clients: Client[] = [];

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN);
  outside = await connectHttpClient(daemon.api.port, TOKEN);
  clients.push(outside);
});

// A limit instead of the default none: a hung cleanup on Windows is to be an error of this file, not an hour of the job.
afterAll(async () => {
  for (const client of clients) await client.close();
  await daemon.stop();
}, 30_000);

async function clientOfSession(session: string): Promise<Client> {
  const token = readFileSync(join(daemon.home, "sessions", session, "session-token"), "utf8");
  const client = await connectHttpClient(daemon.api.port, TOKEN, undefined, { [SESSION_TOKEN_HEADER]: token });
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  return client.callTool({ name, arguments: args });
}

function taskSession(task: string): string {
  const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === task && s.run.kind === "running");
  if (!session) throw new Error(`task ${task} has no running session`);
  return session.id;
}

/** A main session in the repo root, past its `sessionStart`, and its MCP client. */
async function mainSession() {
  const main = await daemon.facade.agents.start("shop");
  await waitFor(daemon.facade.agents, main.id, (s) => s.state?.state === "Input", "sessionStart");
  return { id: main.id, client: await clientOfSession(main.id), window: viewer(daemon.facade.agents, main.id) };
}

/** The fake's prompt line for a typed prompt: "Thinking about: <prompt>". */
const TYPED_MESSAGE = "Thinking about: The session that proposed your task sent you a message in Trackwall: call get_messages";
const TYPED_UPDATES = "Thinking about: There is news about the work you delegated in Trackwall: call get_updates";
const MESSAGE = "Keep the old endpoint.\nIt still has @Deprecated callers in orders-bff.";

describe.skipIf(process.versions.bun === undefined)(
  "messages and updates between a proposer and its task (real PTY and git, fake Copilot CLI)",
  () => {
    test("the proposer messages its task's session, which reads it once, and hears back when the task's turn ends and it reports", async () => {
      const main = await mainSession();
      const { proposal } = ProposeTaskResult.parse(
        (await call(main.client, "propose_task", { repo: "shop", title: "Fix login", prompt: "fix login" })).structuredContent,
      );
      const task = await daemon.post(agentsApi.approveProposal, { proposal: proposal.id, prompt: "fix login" });
      const session = taskSession(task.id);
      await waitFor(daemon.facade.agents, session, (s) => s.state?.state === "Working", "the task prompt's turn");

      const sent = SendMessageResult.parse((await call(main.client, "send_message", { task: task.id, text: MESSAGE })).structuredContent);

      expect(sent).toMatchObject({
        delivery: "queued",
        message: { task: task.id, from: { session: main.id, supervisor: false }, text: MESSAGE, readAt: null },
      });
      expect((await call(outside, "send_message", { task: task.id, text: "Hi" })).content).toEqual([
        { type: "text", text: "bad_request: an agent outside Trackwall sends no messages; follow its tasks with wait_for_session" },
      ]);
      // The user drives the task's first turn (the fake ends a turn after a line and an approval), so it is no update.
      const window = viewer(daemon.facade.agents, session);
      window.attachment.input("start\r");
      await waitFor(daemon.facade.agents, session, (s) => s.state?.state === "Approval", "the approval request");
      window.attachment.input("y\r");
      await waitFor(daemon.facade.agents, session, () => window.unwrappedText().includes(TYPED_MESSAGE), "the typed message prompt");

      const taskClient = await clientOfSession(session);
      const { readAt: _, ...unread } = sent.message;
      expect(GetMessagesResult.parse((await call(taskClient, "get_messages")).structuredContent)).toEqual({ messages: [unread] });
      expect(GetMessagesResult.parse((await call(taskClient, "get_messages")).structuredContent)).toEqual({ messages: [] });
      expect(daemon.facade.agents.sessions().messages).toEqual([{ ...sent.message, readAt: expect.any(String) }]);

      // The turn the daemon's prompt started ends: the proposer is asked to read the update.
      await waitFor(daemon.facade.agents, session, (s) => s.state?.state === "Approval", "the message turn's approval request");
      window.attachment.input("y\r");
      await waitFor(daemon.facade.agents, main.id, () => main.window.unwrappedText().includes(TYPED_UPDATES), "the typed updates prompt");
      expect(GetUpdatesResult.parse((await call(main.client, "get_updates")).structuredContent)).toEqual({
        updates: [{ kind: "turn_ended", task: task.id, session, at: expect.any(String) }],
        dropped: 0,
      });

      await call(taskClient, "report_result", { summary: "Kept the old endpoint, login fixed." });
      expect(GetUpdatesResult.parse((await call(main.client, "get_updates")).structuredContent).updates).toEqual([
        { kind: "result_reported", task: task.id, session, summary: "Kept the old endpoint, login fixed.", at: expect.any(String) },
      ]);

      window.attachment.detach();
      main.window.attachment.detach();
      await daemon.facade.agents.stop(session);
      await daemon.facade.agents.stop(main.id);
      await daemon.post(agentsApi.removeTask, { task: task.id, keepBranch: false, discardChanges: true });
      expect(daemon.facade.agents.sessions().messages).toEqual([]);
    }, 60_000);

    test("a rejection reaches the proposer with the user's reason, and the tools refuse who they are not for", async () => {
      const main = await mainSession();
      const { proposal } = ProposeTaskResult.parse(
        (await call(main.client, "propose_task", { repo: "shop", title: "Add a README", prompt: "add a README" })).structuredContent,
      );

      await daemon.post(agentsApi.rejectProposal, { proposal: proposal.id, reason: "The README is in the wiki" });

      await waitFor(daemon.facade.agents, main.id, () => main.window.unwrappedText().includes(TYPED_UPDATES), "the typed updates prompt");
      expect(GetUpdatesResult.parse((await call(main.client, "get_updates")).structuredContent).updates).toEqual([
        { kind: "proposal_rejected", task: proposal.id, session: null, reason: "The README is in the wiki", at: expect.any(String) },
      ]);
      expect((await call(main.client, "get_messages")).content).toEqual([
        { type: "text", text: "bad_request: only a session that runs a task in Trackwall gets messages" },
      ]);
      expect((await call(outside, "get_updates")).content).toEqual([
        { type: "text", text: "bad_request: an agent outside Trackwall gets no updates; follow its tasks with wait_for_session" },
      ]);
      const typed = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "describe the repo" });
      expect((await call(main.client, "send_message", { task: typed.id, text: "Hi" })).content).toEqual([
        { type: "text", text: `bad_request: the user started task ${typed.id}, so no session sends it messages; tell the user instead` },
      ]);

      main.window.attachment.detach();
      const typedSession = taskSession(typed.id);
      await waitFor(daemon.facade.agents, typedSession, (s) => s.state !== null, "sessionStart");
      await daemon.facade.agents.stop(typedSession);
      await daemon.facade.agents.stop(main.id);
      await daemon.post(agentsApi.removeTask, { task: typed.id, keepBranch: false, discardChanges: true });
    }, 60_000);
  },
);
