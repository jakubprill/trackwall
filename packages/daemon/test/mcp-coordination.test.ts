import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/client";
import {
  agentsApi,
  GetSessionResult,
  ListSessionsResult,
  ProposeTaskResult,
  ReportResultResult,
  WaitForSessionResult,
} from "@trackwall/protocol";
import { loopbackRequest } from "../src/infra/loopback.ts";
import { MCP_PATH, SESSION_TOKEN_HEADER } from "../src/mcp/endpoint.ts";
import { viewer, waitFor } from "./support/agents.ts";
import { connectHttpClient, connectSessionClient } from "./support/mcp-client.ts";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const TOKEN = "c".repeat(43);
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

/** An MCP client as the session's Stdio bridge sees it: with the token from the file in the session directory. */
async function clientOfSession(session: string): Promise<Client> {
  const client = await connectSessionClient(daemon.api.port, daemon.home, session);
  clients.push(client);
  return client;
}

/**
 * Stops a session only after its first state (its input box or the hook of its prompt), when the fake Copilot CLI is up
 * and has drawn its screen: killing a process in ConPTY during its start could hang or crash Bun
 * on Windows (a segfault in `bun test`).
 */
async function stopStarted(session: string): Promise<void> {
  await waitFor(daemon.facade.agents, session, (s) => s.state !== null, "the first state");
  await daemon.facade.agents.stop(session);
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args });
}

describe.skipIf(process.versions.bun === undefined)("main session over MCP (real PTY and git, fake Copilot CLI)", () => {
  test("a proposal from an agent outside Trackwall waits for a decision, and after rejection the wait ends at once", async () => {
    const proposed = ProposeTaskResult.parse(
      (await call(outside, "propose_task", { repo: "shop", title: "Add a README", prompt: "Describe how to run it in the README" }))
        .structuredContent,
    ).proposal;
    expect(proposed).toMatchObject({
      repo: "shop",
      title: "Add a README",
      prompt: "Describe how to run it in the README",
      proposedBy: { session: null, supervisor: false },
    });
    expect(daemon.facade.agents.sessions().proposals).toEqual([proposed]);

    const pending = WaitForSessionResult.parse(
      (await call(outside, "wait_for_session", { task: proposed.id, timeoutSeconds: 1 })).structuredContent,
    );
    expect(pending).toEqual({ status: "proposal_pending", proposal: proposed, task: null, session: null, rejectionReason: null });

    await daemon.post(agentsApi.rejectProposal, { proposal: proposed.id, reason: "  The README is in the wiki  " });
    expect(daemon.facade.agents.sessions().proposals).toEqual([]);
    const started = Date.now();
    const rejected = WaitForSessionResult.parse(
      (await call(outside, "wait_for_session", { task: proposed.id, timeoutSeconds: 30 })).structuredContent,
    );
    expect(rejected).toMatchObject({ status: "proposal_rejected", rejectionReason: "The README is in the wiki" });
    expect(Date.now() - started).toBeLessThan(5000);
  }, 30_000);

  test("a session proposes a task, the user approves it with an edited prompt, and the task's session reports a summary", async () => {
    const main = await daemon.facade.agents.start("shop");
    const mainClient = await clientOfSession(main.id);
    const listed = ListSessionsResult.parse((await call(mainClient, "list_sessions", {})).structuredContent);
    expect(listed.caller).toBe(main.id);

    const { proposal } = ProposeTaskResult.parse(
      (await call(mainClient, "propose_task", { repo: "shop", title: "Fix login", prompt: "fix login" })).structuredContent,
    );
    expect(proposal.proposedBy).toEqual({ session: main.id, supervisor: false });

    const task = await daemon.post(agentsApi.approveProposal, {
      proposal: proposal.id,
      prompt: "fix login and add a test",
      model: null,
      approvals: "ask",
    });
    expect(task).toMatchObject({
      id: proposal.id,
      title: "Fix login",
      prompt: "fix login and add a test",
      proposedBy: { session: main.id, supervisor: false },
      summary: null,
    });
    expect(task.branch).toMatch(/^trackwall\/fix-login-[0-9a-f]{6}$/);
    expect(daemon.facade.agents.sessions().proposals).toEqual([]);

    // The task's session starts with a prompt, so the wait is for its work and does not return at once with "waiting for you".
    const working = WaitForSessionResult.parse(
      (await call(mainClient, "wait_for_session", { task: task.id, timeoutSeconds: 2 })).structuredContent,
    );
    expect(working).toMatchObject({ status: "working", task: { id: task.id }, session: { task: task.id } });
    if (!working.session) throw new Error("waiting for a working task did not return its session");
    const taskSession = working.session.id;

    // The task's agent ends its turn with an approval request: the wait returns, because the session needs a human.
    const window = viewer(daemon.facade.agents, taskSession);
    window.attachment.input("fix login\r");
    const needsYou = WaitForSessionResult.parse(
      (await call(mainClient, "wait_for_session", { task: task.id, timeoutSeconds: 10 })).structuredContent,
    );
    expect(needsYou).toMatchObject({ status: "needs_attention", task: { id: task.id }, session: { id: taskSession } });
    window.attachment.input("1");
    window.attachment.detach();

    const reported = ReportResultResult.parse(
      (await call(await clientOfSession(taskSession), "report_result", { summary: "Login fixed, test in login.test.ts." }))
        .structuredContent,
    );
    expect(reported.task.summary).toEqual({ text: "Login fixed, test in login.test.ts.", reportedAt: expect.any(String) });
    const detail = GetSessionResult.parse((await call(mainClient, "get_session", { session: taskSession })).structuredContent);
    expect(detail.task?.summary?.text).toBe("Login fixed, test in login.test.ts.");

    await daemon.facade.agents.stop(taskSession);
    const exited = WaitForSessionResult.parse(
      (await call(mainClient, "wait_for_session", { session: taskSession, timeoutSeconds: 10 })).structuredContent,
    );
    expect(exited).toMatchObject({ status: "exited", session: { id: taskSession, run: { kind: "exited" } } });
    expect(exited.session?.run).not.toHaveProperty("lastLines");

    // A task without a session (closed in the UI or after a daemon restart) has nothing to wait for.
    daemon.facade.agents.dismiss(taskSession);
    const orphan = WaitForSessionResult.parse(
      (await call(mainClient, "wait_for_session", { task: task.id, timeoutSeconds: 10 })).structuredContent,
    );
    expect(orphan).toMatchObject({ status: "no_session", task: { id: task.id }, session: null });
    await daemon.facade.agents.stop(main.id);
  }, 60_000);

  test("report_result works only in a task's session: an agent outside Trackwall and a session in the repo root get bad_request", async () => {
    const root = await daemon.facade.agents.start("shop");
    for (const client of [outside, await clientOfSession(root.id)]) {
      const result = await call(client, "report_result", { summary: "done" });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: "bad_request: only a session that runs a task in Trackwall can report a result" },
      ]);
    }
    await stopStarted(root.id);
  }, 30_000);

  test("a session cannot wait for itself, and waiting for an unknown task is not_found", async () => {
    const session = await daemon.facade.agents.start("shop");
    const own = await call(await clientOfSession(session.id), "wait_for_session", { session: session.id, timeoutSeconds: 1 });
    expect(own.content).toEqual([{ type: "text", text: "bad_request: a session cannot wait for itself" }]);

    const unknown = await call(outside, "wait_for_session", { task: "00000000-0000-4000-8000-000000000000", timeoutSeconds: 1 });
    expect(unknown.content).toEqual([{ type: "text", text: "not_found: no task or task proposal 00000000-0000-4000-8000-000000000000" }]);

    const both = await call(outside, "wait_for_session", { session: session.id, task: session.id });
    expect(both.isError).toBe(true);
    await stopStarted(session.id);
  }, 30_000);

  test("a proposal in an unknown repo is not_found, and so is approving a proposal that no longer exists", async () => {
    const result = await call(outside, "propose_task", { repo: "skelp", title: "x", prompt: "y" });
    expect(JSON.stringify(result.content)).toContain('"text":"not_found:');
    await expect(
      daemon.post(agentsApi.approveProposal, {
        proposal: "00000000-0000-4000-8000-000000000000",
        prompt: "y",
        model: null,
        approvals: "ask",
      }),
    ).rejects.toThrow("no task proposal");
  });

  test("the daemon refuses a request with an unknown session token instead of treating the session as an agent outside Trackwall", async () => {
    const res = await loopbackRequest(daemon.api.port, MCP_PATH, {
      method: "POST",
      token: TOKEN,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      timeoutMs: 5000,
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", [SESSION_TOKEN_HEADER]: "unknown" },
    });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  });
});
