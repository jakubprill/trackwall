import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { CallEndpointResult, ListServicesResult, StartServiceResult, StopServiceResult } from "@trackwall/protocol";
import { z } from "zod";
import { connectHttpClient, connectSessionClient } from "./support/mcp-client.ts";
import { startSessionApi } from "./support/session-api.ts";

const TOKEN = "t".repeat(43);
const FAKE_MISE = [process.execPath, join(import.meta.dir, "fixtures", "fake-mise.ts")];
/** Fake mise config (see `fixtures/fake-mise.ts`): `dev` runs `fixtures/fake-service.ts`, which logs its port. */
const SERVICE = JSON.stringify({ tasks: [{ name: "dev" }], servers: { dev: {} } });
const TIMEOUT = 60_000;

let daemon: Awaited<ReturnType<typeof startSessionApi>>;
let outside: Client;
const clients: Client[] = [];
const daemonLog: string[] = [];

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN, {
    repos: { shop: { "fake-mise.json": SERVICE }, warehouse: { "fake-mise.json": SERVICE } },
    miseCommand: FAKE_MISE,
    log: (msg) => daemonLog.push(msg),
  });
  outside = await connectHttpClient(daemon.api.port, TOKEN);
  clients.push(outside);
});

afterAll(async () => {
  for (const client of clients) await client.close();
  await daemon.stop();
});

async function call(client: Client, name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args });
}

function errorText(result: Awaited<ReturnType<typeof call>>): string {
  expect(result.isError).toBe(true);
  const [first] = z.array(z.object({ text: z.string() })).parse(result.content);
  return first?.text ?? "";
}

describe("services over MCP (real process groups, fake mise and fake service)", () => {
  test(
    "start_service waits until the service is healthy, call_endpoint reaches it and stop_service stops it",
    async () => {
      const { slice } = StartServiceResult.parse(
        (await call(outside, "start_service", { repo: "shop", timeoutSeconds: 30 })).structuredContent,
      );
      expect(slice).toMatchObject({
        repo: "shop",
        settled: true,
        members: [{ repo: "shop", outcome: "started", service: { state: "healthy" } }],
      });

      const secret = "Bearer abcdefgh-secret";
      const result = await call(outside, "call_endpoint", {
        repo: "shop",
        method: "POST",
        path: "/api/orders",
        headers: { authorization: secret },
        body: '{"lines":[]}',
      });
      const called = CallEndpointResult.parse(result.structuredContent);
      expect(called.response?.status).toBe(200);
      expect(JSON.parse(called.response?.body ?? "")).toMatchObject({ method: "POST", path: "/api/orders", body: '{"lines":[]}' });
      // The audit line names the service and method, not the headers and the body, which may carry a secret.
      expect(daemonLog.filter((l) => l.startsWith("call_endpoint: {"))).toEqual(['call_endpoint: {"repo":"shop","method":"POST"}']);
      expect(daemonLog.join("\n")).not.toContain(secret);

      const { services } = ListServicesResult.parse((await call(outside, "list_services", {})).structuredContent);
      expect(services.map((s) => [s.repo, s.state, s.portSource])).toEqual([["shop", "healthy", "log"]]);
      const stopped = StopServiceResult.parse((await call(outside, "stop_service", { repo: "shop" })).structuredContent);
      expect(stopped.services.map((s) => [s.repo, s.state])).toEqual([["shop", "stopped"]]);
      expect(errorText(await call(outside, "call_endpoint", { repo: "shop", path: "/" }))).toBe(
        "service_unavailable: the service of shop is stopped",
      );
    },
    TIMEOUT,
  );
});

describe.skipIf(process.versions.bun === undefined)("services from a Trackwall session (real PTY, fake Copilot CLI)", () => {
  test(
    "a session starts and stops only the service of its own repo",
    async () => {
      const session = await daemon.facade.agents.start("warehouse");
      const client = await connectSessionClient(daemon.api.port, TOKEN, daemon.home, session.id);
      clients.push(client);

      expect(errorText(await call(client, "start_service", { repo: "shop" }))).toBe(
        "bad_request: a session in warehouse can start and stop only the service of warehouse, not of shop",
      );
      expect(errorText(await call(client, "stop_service", { repo: "shop" }))).toStartWith("bad_request:");
    },
    TIMEOUT,
  );

  test(
    "a task session starts the service from its own worktree on the task port, calls it, and cannot start another task's",
    async () => {
      const own = await daemon.facade.agents.createTask("warehouse", "check the orders endpoint");
      const other = await daemon.facade.agents.createTask("warehouse", "another task");
      const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === own.id);
      if (!session) throw new Error("the task has no session");
      const client = await connectSessionClient(daemon.api.port, TOKEN, daemon.home, session.id);
      clients.push(client);

      const { slice } = StartServiceResult.parse(
        (await call(client, "start_service", { repo: "warehouse", task: own.id, timeoutSeconds: 30 })).structuredContent,
      );
      expect(slice.members).toMatchObject([{ repo: "warehouse", task: own.id, service: { state: "healthy", port: own.port } }]);
      const called = CallEndpointResult.parse(
        (await call(client, "call_endpoint", { repo: "warehouse", task: own.id, path: "/" })).structuredContent,
      );
      // macOS: the temporary directory is a link (/var → /private/var), and the service sees the real path.
      expect(JSON.parse(called.response?.body ?? "")).toMatchObject({ cwd: realpathSync(own.worktree), port: String(own.port) });

      expect(errorText(await call(client, "start_service", { repo: "warehouse", task: other.id }))).toBe(
        `bad_request: a session of task ${own.id} can start and stop only the service of its own worktree, not of that of task ${other.id}`,
      );
      await call(client, "stop_service", { repo: "warehouse", task: own.id });
    },
    TIMEOUT,
  );
});
