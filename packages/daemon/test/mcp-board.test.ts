import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/client";
import { agentsApi, BoardItemResult, boardApi, GetItemResult, ListItemsResult, ProposeTaskResult } from "@trackwall/protocol";
import { waitFor } from "./support/agents.ts";
import { connectHttpClient, connectSessionClient } from "./support/mcp-client.ts";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const TOKEN = "b".repeat(43);
let daemon: Awaited<ReturnType<typeof startSessionApi>>;
const clients: Client[] = [];

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN);
}, SLOW_TEST_TIMEOUT_MS);

afterAll(async () => {
  for (const client of clients) await client.close();
  await daemon.stop();
}, 30_000);

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(JSON.stringify(result.content));
  return result.structuredContent;
}

async function outsideAgent(): Promise<Client> {
  const client = await connectHttpClient(daemon.api.port, TOKEN);
  clients.push(client);
  return client;
}

function sessionOf(task: string): string {
  const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === task && s.run.kind === "running");
  if (!session) throw new Error(`task ${task} has no running session`);
  return session.id;
}

describe.skipIf(process.versions.bun === undefined)("the board over MCP (ADR-133, real PTY and git, fake Copilot CLI)", () => {
  test("an agent writes an idea into the inbox, finds it there and moves it to ready, but not further", async () => {
    const agent = await outsideAgent();
    const { item } = BoardItemResult.parse(
      await call(agent, "create_item", { title: "Retry the invoice export", body: "It times out at night.", repos: ["shop"] }),
    );
    expect(item).toMatchObject({ kind: "item", parent: null, column: "ideas", repos: ["shop"], createdBy: { kind: "agent", task: null } });

    const inbox = ListItemsResult.parse(await call(agent, "list_items", { inbox: true, query: "invoice" }));
    expect(inbox.items.map((it) => [it.title, it.excerpt, it.children, it.tasks])).toEqual([
      ["Retry the invoice export", "It times out at night.", 0, 0],
    ]);

    const ready = BoardItemResult.parse(await call(agent, "update_item", { item: item.id, column: "ready" }));
    expect(ready.item.column).toBe("ready");
    await expect(call(agent, "update_item", { item: item.id, column: "done" })).rejects.toThrow("column");
  });

  test("a task started on an item works on it, and what its agent writes down lands under that item", async () => {
    const project = await daemon.post(boardApi.create, { kind: "project", title: "Order history", column: "ready" });
    const item = await daemon.post(boardApi.create, { kind: "item", title: "Endpoint in the BFF", parent: project.id, repos: ["shop"] });
    const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "add the endpoint", approvals: "ask", item: item.id });
    expect(task.item).toBe(item.id);

    const session = sessionOf(task.id);
    await waitFor(daemon.facade.agents, session, (s) => s.state !== null, "sessionStart");
    const agent = await connectSessionClient(daemon.api.port, daemon.home, session);
    clients.push(agent);
    const { item: found } = BoardItemResult.parse(await call(agent, "create_item", { title: "Paging is missing in the DTO" }));
    expect(found).toMatchObject({ parent: item.id, column: "ideas", createdBy: { kind: "agent", task: task.id } });

    const read = GetItemResult.parse(await call(agent, "get_item", { item: item.id }));
    expect(read.path).toEqual([{ id: project.id, kind: "project", title: "Order history" }]);
    expect(read.children.map((c) => c.title)).toEqual(["Paging is missing in the DTO"]);
    expect(read.tasks.map((t) => t.id)).toEqual([task.id]);

    await daemon.facade.agents.stop(session);
    await daemon.post(agentsApi.removeTask, { task: task.id, keepBranch: false, discardChanges: true });
  }, 60_000);

  test("a task proposed for an item keeps the item once the user starts it", async () => {
    const item = await daemon.post(boardApi.create, { kind: "item", title: "Health endpoint" });
    const agent = await outsideAgent();
    const { proposal } = ProposeTaskResult.parse(
      await call(agent, "propose_task", { repo: "shop", title: "Add a health endpoint", prompt: "add /health", item: item.id }),
    );
    expect(proposal.item).toBe(item.id);

    const task = await daemon.post(agentsApi.approveProposal, {
      proposal: proposal.id,
      prompt: proposal.prompt,
      model: null,
      approvals: "ask",
    });
    expect(task.item).toBe(item.id);
    await daemon.facade.agents.stop(sessionOf(task.id));
    await daemon.post(agentsApi.removeTask, { task: task.id, keepBranch: false, discardChanges: true });
  }, 60_000);

  test("a task or a proposal for an item that is not on the board is refused before anything starts", async () => {
    const missing = "5b0c6a7e-0000-4000-8000-0000000000ff";
    await expect(
      daemon.post(agentsApi.createTask, { repo: "shop", prompt: "add the endpoint", approvals: "ask", item: missing }),
    ).rejects.toThrow(`no board item ${missing}`);
    const agent = await outsideAgent();
    await expect(call(agent, "propose_task", { repo: "shop", title: "Add", prompt: "add", item: missing })).rejects.toThrow("not_found");
    expect(daemon.facade.agents.sessions().tasks).toEqual([]);
  });
});
