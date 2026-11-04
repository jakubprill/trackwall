import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { type AddressInfo, createServer as createNetServer, connect as netConnect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFacade } from "../src/facade.ts";
import { fakeHostingClis } from "./support/hosting.ts";

const fakeMise = join(import.meta.dir, "fixtures", "fake-mise.ts");
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A model provider on 127.0.0.1 that answers `GET /v1/models` with `answer` and keeps each request's path and headers. */
async function startProvider(answer: { status: number; body: unknown }) {
  const requests: { method: string; url: string; headers: IncomingHttpHeaders }[] = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    res.writeHead(answer.status, { "content-type": "application/json" });
    res.end(JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  cleanups.push(() => server.close());
  return { port, requests };
}

/** An HTTP proxy that tunnels every `CONNECT` to 127.0.0.1 on the port asked for, and keeps each request head. */
async function startProxy() {
  const heads: string[] = [];
  const proxy = createNetServer((client: Socket) => {
    let head = "";
    const onData = (chunk: Buffer) => {
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      client.off("data", onData);
      heads.push(head);
      const port = Number(/^CONNECT [^:]+:(\d+) /.exec(head)?.[1]);
      const upstream = netConnect({ host: "127.0.0.1", port }, () => {
        client.write("HTTP/1.1 200 Connection established\r\n\r\n");
        client.pipe(upstream).pipe(client);
      });
      upstream.on("error", () => client.destroy());
    };
    client.on("data", onData);
    client.on("error", () => {});
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const { port } = proxy.address() as AddressInfo;
  cleanups.push(() => proxy.close());
  return { url: `http://127.0.0.1:${port}`, heads };
}

/** The daemon with a fake mise whose session profile `byok` sets `profileEnv`; no proxy from the runner's environment. */
async function facadeWith(profileEnv: Record<string, string>) {
  const home = mkdtempSync(join(tmpdir(), "trackwall-models-home-"));
  const projects = mkdtempSync(join(tmpdir(), "trackwall-models-projects-"));
  writeFileSync(join(projects, "fake-mise.json"), JSON.stringify({ tasks: [], env: {}, envByMiseEnv: { byok: profileEnv } }));
  const facade = createFacade({
    inContainer: false,
    home,
    homeFrom: "flag",
    openUrl: () => {},
    openFolder: () => {},
    miseCommand: [process.execPath, fakeMise],
    copilotCommand: ["trackwall-test-no-copilot"],
    version: "0.0.0-test",
    sessionHook: () => ({ url: "http://127.0.0.1:9/hooks/unused", headers: {} }),
    sessionMcpServer: () => ({ url: "http://127.0.0.1:9/mcp", headers: {} }),
    hostingClis: fakeHostingClis({}).clis,
    userEnv: async () => ({ PATH: process.env.PATH }),
    log: () => {},
  });
  await facade.workspace.setProjectsDir(projects);
  return facade;
}

const MODELS = {
  object: "list",
  data: [
    { id: "gpt-6.1-sol", object: "model", context_window: 400000 },
    { id: "claude-opus-5.5", object: "model", context_window: 200000, max_output_tokens: 64000 },
    { id: "text-embedding-3-large", object: "model" },
    { id: "claude-opus-5.5", object: "model" },
    { id: "not a model id", object: "model" },
    { name: "an entry without an id" },
  ],
};

describe("provider models: what the session profile's provider offers (ADR-194)", () => {
  test("without a session profile nothing is listed and mise is not asked", async () => {
    const facade = await facadeWith({});
    expect(await facade.providerModels.list()).toEqual({ profile: null, models: [], problem: null });
  });

  test("the daemon asks the provider's /models with the profile's key and lists its chat models once each, by id", async () => {
    const provider = await startProvider({ status: 200, body: MODELS });
    const facade = await facadeWith({
      COPILOT_PROVIDER_BASE_URL: `http://127.0.0.1:${provider.port}/v1/`,
      COPILOT_PROVIDER_API_KEY: "sk-local-key",
      COPILOT_PROVIDER_HEADERS: "X-Tenant: team-a\\nHost: elsewhere.example",
    });
    facade.workspace.setSessionProfile("byok");

    expect(await facade.providerModels.list()).toEqual({
      profile: "byok",
      models: [
        { id: "claude-opus-5.5", contextWindow: 200000 },
        { id: "gpt-6.1-sol", contextWindow: 400000 },
      ],
      problem: null,
    });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toMatchObject({ method: "GET", url: "/v1/models" });
    expect(provider.requests[0]?.headers).toMatchObject({ authorization: "Bearer sk-local-key", "x-tenant": "team-a" });
    expect(provider.requests[0]?.headers.host).toBe(`127.0.0.1:${provider.port}`);
  });

  test("a list asked for again within minutes is the one kept, without asking the provider", async () => {
    const provider = await startProvider({ status: 200, body: MODELS });
    const facade = await facadeWith({ COPILOT_PROVIDER_BASE_URL: `http://127.0.0.1:${provider.port}/v1` });
    facade.workspace.setSessionProfile("byok");

    await facade.providerModels.list();
    const again = await facade.providerModels.list();

    expect(again.models.map((m) => m.id)).toEqual(["claude-opus-5.5", "gpt-6.1-sol"]);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.headers.authorization).toBeUndefined();
  });

  test("a provider that refuses the key gives a problem that names neither its address nor the key, and is asked again next time", async () => {
    const provider = await startProvider({ status: 401, body: { error: { message: "invalid key" } } });
    const facade = await facadeWith({
      COPILOT_PROVIDER_BASE_URL: `http://127.0.0.1:${provider.port}/v1`,
      COPILOT_PROVIDER_API_KEY: "sk-wrong-key",
    });
    facade.workspace.setSessionProfile("byok");

    const list = await facade.providerModels.list();
    await facade.providerModels.list();

    expect(list).toEqual({
      profile: "byok",
      models: [],
      problem: "The model provider of the session profile did not accept its key when asked for its models (401).",
    });
    expect(JSON.stringify(list)).not.toContain(String(provider.port));
    expect(provider.requests).toHaveLength(2);
  });

  test("a provider nobody listens at is a problem without its address", async () => {
    const provider = await startProvider({ status: 200, body: MODELS });
    const facade = await facadeWith({ COPILOT_PROVIDER_BASE_URL: "http://127.0.0.1:9/v1" });
    facade.workspace.setSessionProfile("byok");
    expect(provider.requests).toHaveLength(0);

    expect(await facade.providerModels.list()).toEqual({
      profile: "byok",
      models: [],
      problem: "The model provider of the session profile could not be asked for its models: it does not accept connections.",
    });
  });

  test("an answer that is not a list of models is a problem", async () => {
    const provider = await startProvider({ status: 200, body: { models: ["gpt-6.1-sol"] } });
    const facade = await facadeWith({ COPILOT_PROVIDER_BASE_URL: `http://127.0.0.1:${provider.port}/v1` });
    facade.workspace.setSessionProfile("byok");

    expect((await facade.providerModels.list()).problem).toBe(
      "The model provider of the session profile did not answer with a list of models.",
    );
  });

  test("through the proxy of the profile's environment the request goes over a CONNECT tunnel", async () => {
    const provider = await startProvider({ status: 200, body: MODELS });
    const proxy = await startProxy();
    const facade = await facadeWith({
      COPILOT_PROVIDER_BASE_URL: `http://provider.example.org:${provider.port}/v1`,
      COPILOT_PROVIDER_API_KEY: "sk-local-key",
      HTTP_PROXY: proxy.url,
    });
    facade.workspace.setSessionProfile("byok");

    const list = await facade.providerModels.list();

    expect(list.problem).toBeNull();
    expect(list.models.map((m) => m.id)).toEqual(["claude-opus-5.5", "gpt-6.1-sol"]);
    expect(proxy.heads).toEqual([
      `CONNECT provider.example.org:${provider.port} HTTP/1.1\r\nHost: provider.example.org:${provider.port}\r\n\r\n`,
    ]);
    expect(provider.requests[0]?.headers.host).toBe(`provider.example.org:${provider.port}`);
  });

  test("a key from a command is not run, and the profile says why nothing is listed", async () => {
    const facade = await facadeWith({
      COPILOT_PROVIDER_BASE_URL: "http://127.0.0.1:9/v1",
      COPILOT_PROVIDER_API_KEY_COMMAND: "print-key",
    });
    facade.workspace.setSessionProfile("byok");

    expect(await facade.providerModels.list()).toEqual({
      profile: "byok",
      models: [],
      problem:
        "The key comes from COPILOT_PROVIDER_API_KEY_COMMAND, which Trackwall does not run, so it cannot ask the provider for its models.",
    });
  });

  test("a provider of another type than OpenAI-compatible is not asked", async () => {
    const facade = await facadeWith({ COPILOT_PROVIDER_BASE_URL: "http://127.0.0.1:9/v1", COPILOT_PROVIDER_TYPE: "anthropic" });
    facade.workspace.setSessionProfile("byok");

    expect((await facade.providerModels.list()).problem).toBe(
      "Trackwall lists the models only of an OpenAI-compatible provider, and COPILOT_PROVIDER_TYPE is anthropic.",
    );
  });

  test("a profile that sets no provider lists nothing, without a problem", async () => {
    const facade = await facadeWith({ SOME_TOOL_HOME: "/opt/tool" });
    facade.workspace.setSessionProfile("byok");

    expect(await facade.providerModels.list()).toEqual({ profile: "byok", models: [], problem: null });
  });
});
