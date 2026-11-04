import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { modelOfArgs } from "../src/modules/agents/model-args.ts";
import { ProviderModels } from "../src/modules/provider-models/provider-models.ts";

/**
 * A provider where `gpt-6.1-sol` answers only in the Responses API and `broken` only with a 500; it counts what it is
 * sent, by method, path, model and key.
 */
const sent: string[] = [];
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let text = "";
    req.on("data", (chunk) => {
      text += chunk;
    });
    req.on("end", () => {
      const { model } = JSON.parse(text || "{}") as { model?: string };
      sent.push(`${req.method} ${req.url} ${model} ${req.headers.authorization}`);
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "gpt-6.1-sol" }, { id: "claude-opus-5.5" }] }));
        return;
      }
      const status = model === "broken" ? 500 : (req.url === "/v1/responses") === (model === "gpt-6.1-sol") ? 200 : 400;
      res.writeHead(status, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(() => server.close());

beforeEach(() => {
  sent.length = 0;
});

function providerModels(env: NodeJS.ProcessEnv = {}) {
  const logged: string[] = [];
  const models = new ProviderModels({
    profileEnv: async () => ({ profile: "byok", env, problem: null }),
    ca: async () => [],
    log: (msg) => logged.push(msg),
  });
  return { models, logged };
}

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { COPILOT_PROVIDER_BASE_URL: base, COPILOT_PROVIDER_API_KEY: "k1", ...extra };
}

describe("the format a session's model is started in (ADR-200)", () => {
  test("sessions that start together on one model ask the provider once", async () => {
    const { models } = providerModels();

    expect(await Promise.all([models.wireApiFor("gpt-6.1-sol", env()), models.wireApiFor("gpt-6.1-sol", env())])).toEqual([
      "responses",
      "responses",
    ]);
    expect(sent.sort()).toEqual(["POST /v1/chat/completions gpt-6.1-sol Bearer k1", "POST /v1/responses gpt-6.1-sol Bearer k1"]);
  });

  test("a changed key asks again", async () => {
    const { models } = providerModels();
    await models.wireApiFor("gpt-6.1-sol", env());
    await models.wireApiFor("gpt-6.1-sol", env({ COPILOT_PROVIDER_API_KEY: "k2" }));

    expect(sent.filter((s) => s.endsWith("Bearer k2"))).toHaveLength(2);
  });

  test("a format the environment already names is left as it is", async () => {
    const { models } = providerModels();

    expect(await models.wireApiFor("gpt-6.1-sol", env({ COPILOT_PROVIDER_WIRE_API: "responses" }))).toBeNull();
    expect(await models.wireApiFor("claude-opus-5.5", env())).toBeNull();
  });

  test("a probe that tells nothing keeps the environment's format and is not repeated within a minute", async () => {
    const { models, logged } = providerModels();

    expect(await models.wireApiFor("broken", env())).toBeNull();
    expect(await models.wireApiFor("broken", env())).toBeNull();
    expect(sent).toHaveLength(2);
    expect(logged).toEqual(["the model provider did not tell which format model broken answers in; the session keeps its own"]);
  });

  test("a provider reached over WebSockets is not probed", async () => {
    const { models } = providerModels();

    expect(await models.wireApiFor("gpt-6.1-sol", env({ COPILOT_PROVIDER_TRANSPORT: "websockets" }))).toBeNull();
    expect(sent).toEqual([]);
  });

  test("the list of models shows the format a probe learned", async () => {
    const { models } = providerModels(env());
    await models.wireApiFor("gpt-6.1-sol", env());

    expect((await models.list()).models).toEqual([
      { id: "claude-opus-5.5", contextWindow: null, wireApi: null },
      { id: "gpt-6.1-sol", contextWindow: null, wireApi: "responses" },
    ]);
  });
});

describe("the model a start's arguments name", () => {
  test("the last --model counts, in either of its forms, and none is null", () => {
    expect(modelOfArgs(["--model", "a", "--yolo", "--model=b"])).toBe("b");
    expect(modelOfArgs(["--model=a", "--model", "b"])).toBe("b");
    expect(modelOfArgs(["--yolo"])).toBeNull();
  });
});
