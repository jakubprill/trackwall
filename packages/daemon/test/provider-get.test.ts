import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer as createHttpsServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { chatModels } from "../src/modules/provider-models/model-list.ts";
import { parseAnswer, providerGet } from "../src/modules/provider-models/provider-get.ts";
import { providerRequest } from "../src/modules/provider-models/provider-request.ts";
import { INSPECTION_CA, LOCALHOST_CERT, LOCALHOST_KEY } from "./fixtures/tls-certificates.ts";

let server: Server;
let port: number;

beforeAll(async () => {
  server = createHttpsServer({ key: LOCALHOST_KEY, cert: `${LOCALHOST_CERT}\n${INSPECTION_CA}` }, (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "gpt-6.1-sol" }], path: req.url, auth: req.headers.authorization }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => server.close());

const OPTIONS = { env: {}, timeoutMs: 5_000, maxBytes: 64 * 1024 };

describe("the request to the provider (ADR-194)", () => {
  test("over HTTPS it trusts the certificates a session trusts and reads the answer", async () => {
    const answer = await providerGet(
      new URL(`https://localhost:${port}/v1/models`),
      { Authorization: "Bearer k" },
      { ...OPTIONS, ca: [INSPECTION_CA] },
    );
    expect(answer).toEqual({
      kind: "answer",
      status: 200,
      body: JSON.stringify({ data: [{ id: "gpt-6.1-sol" }], path: "/v1/models", auth: "Bearer k" }),
    });
  });

  test("a certificate no given authority signed is a failure that names its code, and the request is not sent", async () => {
    const answer = await providerGet(new URL(`https://localhost:${port}/v1/models`), { Authorization: "Bearer k" }, { ...OPTIONS, ca: [] });
    expect(answer).toEqual({ kind: "failed", reason: "its certificate is not trusted (SELF_SIGNED_CERT_IN_CHAIN)" });
  });

  test("an answer larger than the limit is cut", async () => {
    const answer = await providerGet(new URL(`https://localhost:${port}/v1/models`), {}, { ...OPTIONS, ca: [INSPECTION_CA], maxBytes: 16 });
    expect(answer).toEqual({ kind: "failed", reason: "its answer is too large for a list of models" });
  });
});

describe("reading the provider's answer", () => {
  test("a chunked body is joined", () => {
    const raw = 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n{"da\r\n8;ext=1\r\nta":[]} \r\n0\r\n\r\n';
    expect(parseAnswer(Buffer.from(raw))).toEqual({ kind: "answer", status: 200, body: '{"data":[]} ' });
  });

  test("a body shorter than its Content-Length was cut off", () => {
    const raw = 'HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\n{"data":[]}';
    expect(parseAnswer(Buffer.from(raw))).toEqual({ kind: "failed", reason: "its answer was cut off" });
  });

  test("an answer without an HTTP status line is not HTTP", () => {
    expect(parseAnswer(Buffer.from("SSH-2.0-OpenSSH\r\n\r\n"))).toEqual({ kind: "failed", reason: "its answer is not HTTP" });
  });
});

describe("the models request from the profile's environment", () => {
  test("a bearer token goes before an API key, and the extra headers come along", () => {
    const request = providerRequest(
      {
        COPILOT_PROVIDER_BASE_URL: "https://gateway.example.org/openai/v1?tenant=a",
        COPILOT_PROVIDER_API_KEY: "key",
        COPILOT_PROVIDER_BEARER_TOKEN: "token",
        COPILOT_PROVIDER_HEADERS: "X-Team: a\nnot a header\nBad Name: x",
      },
      "byok",
    );
    expect(request).toEqual({
      kind: "request",
      url: new URL("https://gateway.example.org/openai/v1/models?tenant=a"),
      headers: { "X-Team": "a", Authorization: "Bearer token" },
    });
  });

  test("an address that is not http or https is a problem of the profile", () => {
    expect(providerRequest({ COPILOT_PROVIDER_BASE_URL: "ftp://gateway.example.org" }, "byok")).toEqual({
      kind: "unsupported",
      problem: "COPILOT_PROVIDER_BASE_URL of the session profile byok is not an http or https address.",
    });
  });
});

describe("the chat models of a /models answer", () => {
  test("embedding models and entries that are not model ids are left out, each id once, sorted", () => {
    const body = JSON.stringify({
      data: [
        { id: "b-model", context_window: 1000 },
        { id: "text-embedding-3-small" },
        { id: "a-model" },
        { id: "b-model" },
        { id: "x y" },
        7,
      ],
    });
    expect(chatModels(body)).toEqual([
      { id: "a-model", contextWindow: null },
      { id: "b-model", contextWindow: 1000 },
    ]);
  });

  test("an answer that is not JSON or has no data list is not a list of models", () => {
    expect(chatModels("<html>")).toBeNull();
    expect(chatModels('{"models":[]}')).toBeNull();
  });
});
