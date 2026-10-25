import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { CallEndpointResult, ListServicesResult, StartServiceResult, StopServiceResult } from "@trackwall/protocol";
import { z } from "zod";
import { SESSION_TOKEN_HEADER } from "../src/mcp/endpoint.ts";
import { connectHttpClient } from "./support/mcp-client.ts";
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
    repos: { sklep: { "fake-mise.json": SERVICE }, magazyn: { "fake-mise.json": SERVICE } },
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
        (await call(outside, "start_service", { repo: "sklep", timeoutSeconds: 30 })).structuredContent,
      );
      expect(slice).toMatchObject({
        repo: "sklep",
        settled: true,
        members: [{ repo: "sklep", outcome: "started", service: { state: "healthy" } }],
      });

      const secret = "Bearer abcdefgh-secret";
      const result = await call(outside, "call_endpoint", {
        repo: "sklep",
        method: "POST",
        path: "/api/orders",
        headers: { authorization: secret },
        body: '{"lines":[]}',
      });
      const called = CallEndpointResult.parse(result.structuredContent);
      expect(called.response?.status).toBe(200);
      expect(JSON.parse(called.response?.body ?? "")).toMatchObject({ method: "POST", path: "/api/orders", body: '{"lines":[]}' });
      // The audit line names the service and method, not the headers and the body, which may carry a secret.
      expect(daemonLog.filter((l) => l.startsWith("call_endpoint: {"))).toEqual(['call_endpoint: {"repo":"sklep","method":"POST"}']);
      expect(daemonLog.join("\n")).not.toContain(secret);

      const { services } = ListServicesResult.parse((await call(outside, "list_services", {})).structuredContent);
      expect(services.map((s) => [s.repo, s.state, s.portSource])).toEqual([["sklep", "healthy", "log"]]);
      const stopped = StopServiceResult.parse((await call(outside, "stop_service", { repo: "sklep" })).structuredContent);
      expect(stopped.services.map((s) => [s.repo, s.state])).toEqual([["sklep", "stopped"]]);
      expect(errorText(await call(outside, "call_endpoint", { repo: "sklep", path: "/" }))).toBe(
        "service_unavailable: the service of sklep is stopped",
      );
    },
    TIMEOUT,
  );
});

describe.skipIf(process.versions.bun === undefined)("services from a Trackwall session (real PTY, fake Copilot CLI)", () => {
  test(
    "a session starts and stops only the service of its own repo",
    async () => {
      const session = await daemon.facade.agents.start("magazyn");
      const token = readFileSync(join(daemon.home, "sessions", session.id, "session-token"), "utf8");
      const client = await connectHttpClient(daemon.api.port, TOKEN, undefined, { [SESSION_TOKEN_HEADER]: token });
      clients.push(client);

      expect(errorText(await call(client, "start_service", { repo: "sklep" }))).toBe(
        "bad_request: a session in magazyn can start and stop only the service of magazyn, not of sklep",
      );
      expect(errorText(await call(client, "stop_service", { repo: "sklep" }))).toStartWith("bad_request:");
    },
    TIMEOUT,
  );
});
