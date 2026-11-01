import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { agentsApi, mcpAuditApi } from "@trackwall/protocol";
import { waitFor } from "./support/agents.ts";
import { connectHttpClient, connectSessionClient } from "./support/mcp-client.ts";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const TOKEN = "c".repeat(43);
let daemon: Awaited<ReturnType<typeof startSessionApi>>;
const clients: Client[] = [];

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN);
}, SLOW_TEST_TIMEOUT_MS);

afterAll(async () => {
  for (const client of clients) await client.close();
  await daemon.stop();
}, 30_000);

async function outsideAgent(): Promise<Client> {
  const client = await connectHttpClient(daemon.api.port, TOKEN);
  clients.push(client);
  return client;
}

async function newestCall() {
  const { calls } = await daemon.post(mcpAuditApi.calls, {});
  if (!calls[0]) throw new Error("the audit has no calls");
  return calls[0];
}

describe.skipIf(process.versions.bun === undefined)("the MCP audit through the real MCP server (ADR-152, fake Copilot CLI)", () => {
  test("a call of an agent outside Trackwall is in the audit with the repo it named, its effect and how long it took", async () => {
    const agent = await outsideAgent();
    await agent.callTool({ name: "get_repo", arguments: { repo: "shop" } });

    expect(await newestCall()).toMatchObject({
      tool: "get_repo",
      effect: "read",
      caller: null,
      args: { repo: "shop" },
      outcome: { kind: "ok" },
    });
  });

  test("a proposal keeps its repo but never its title or prompt, which are free text", async () => {
    const agent = await outsideAgent();
    await agent.callTool({
      name: "propose_task",
      arguments: { repo: "shop", title: "Rotate the key", prompt: "use the key sk-live-0123456789abcdef in the config" },
    });

    const call = await newestCall();
    expect(call).toMatchObject({ tool: "propose_task", effect: "write", args: { repo: "shop" }, outcome: { kind: "ok" } });
    expect(JSON.stringify(call)).not.toContain("Rotate the key");
    const file = readFileSync(join(daemon.home, "logs", "mcp-calls.jsonl"), "utf8");
    expect(file).not.toContain("sk-live-0123456789abcdef");
  });

  test("a failed call keeps the code and text the agent read", async () => {
    const agent = await outsideAgent();
    await agent.callTool({ name: "get_repo", arguments: { repo: "no-such-repo" } });

    expect(await newestCall()).toMatchObject({
      tool: "get_repo",
      args: { repo: "no-such-repo" },
      outcome: { kind: "error", code: "not_found", message: 'no repo "no-such-repo" in the projects folder' },
    });
  });

  test("arguments the tool's schema refuses never reach the tool, so the audit has nothing of them", async () => {
    const agent = await outsideAgent();
    await agent.callTool({ name: "list_repos", arguments: {} });
    const refused = await agent.callTool({ name: "get_errors", arguments: { minLevel: "loud", contains: "password=hunter2" } });

    expect(refused.isError).toBe(true);
    expect(await newestCall()).toMatchObject({ tool: "list_repos" });
    expect(readFileSync(join(daemon.home, "logs", "mcp-calls.jsonl"), "utf8")).not.toContain("hunter2");
  });

  test("a task session's call names its session, repo and task, and the task's own list holds only its calls", async () => {
    const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "look around", approvals: "ask" });
    const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === task.id && s.run.kind === "running");
    if (!session) throw new Error(`task ${task.id} has no running session`);
    await waitFor(daemon.facade.agents, session.id, (s) => s.state !== null, "sessionStart");
    const agent = await connectSessionClient(daemon.api.port, daemon.home, session.id);
    clients.push(agent);
    await agent.callTool({ name: "list_running_mise_tasks", arguments: {} });

    const { calls } = await daemon.post(mcpAuditApi.calls, { task: task.id });
    expect(calls.map((c) => [c.tool, c.caller])).toEqual([
      ["list_running_mise_tasks", { session: session.id, repo: "shop", task: task.id, supervisor: false }],
    ]);

    await daemon.facade.agents.stop(session.id);
    await daemon.post(agentsApi.removeTask, { task: task.id, keepBranch: false, discardChanges: true });
  }, 60_000);
});
