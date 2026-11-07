import { describe, expect, test } from "bun:test";
import type { ProviderAnswer, ProviderCall } from "../src/modules/provider-models/provider-call.ts";
import { probeWireApis } from "../src/modules/provider-models/wire-api-probe.ts";

const BASE = new URL("https://gateway.example.org/v1");

/** A provider that answers each format's path with the given status, and keeps what it was sent. */
function provider(statuses: { completions: number | "failed"; responses: number | "failed" }) {
  const sent: ProviderCall[] = [];
  const call = async (request: ProviderCall): Promise<ProviderAnswer> => {
    sent.push(request);
    const status = request.url.pathname.endsWith("/responses") ? statuses.responses : statuses.completions;
    return status === "failed" ? { kind: "failed", reason: "it does not accept connections" } : { kind: "answer", status, body: "{}" };
  };
  return { sent, call };
}

describe("which format a model answers in (ADR-200)", () => {
  test("one smallest request in each format, with the profile's headers, tells the one that answered", async () => {
    const { sent, call } = provider({ completions: 400, responses: 200 });

    expect(await probeWireApis(BASE, { Authorization: "Bearer k" }, "gpt-6.1-sol", call)).toEqual({
      kind: "answered",
      works: ["responses"],
    });
    expect(sent).toEqual([
      {
        url: new URL("https://gateway.example.org/v1/chat/completions"),
        headers: { Authorization: "Bearer k" },
        body: { model: "gpt-6.1-sol", messages: [{ role: "user", content: "ping" }], max_completion_tokens: 16, stream: false },
      },
      {
        url: new URL("https://gateway.example.org/v1/responses"),
        headers: { Authorization: "Bearer k" },
        body: { model: "gpt-6.1-sol", input: "ping", max_output_tokens: 16, stream: false },
      },
    ]);
  });

  test("a model that answers in both formats, or in neither, is told as it is", async () => {
    expect(await probeWireApis(BASE, {}, "m", provider({ completions: 200, responses: 200 }).call)).toEqual({
      kind: "answered",
      works: ["completions", "responses"],
    });
    expect(await probeWireApis(BASE, {}, "m", provider({ completions: 401, responses: 401 }).call)).toEqual({
      kind: "answered",
      works: [],
    });
  });

  test("a provider that cannot be reached, is overloaded or limits the rate tells nothing", async () => {
    expect(await probeWireApis(BASE, {}, "m", provider({ completions: "failed", responses: 200 }).call)).toEqual({ kind: "unknown" });
    expect(await probeWireApis(BASE, {}, "m", provider({ completions: 503, responses: 200 }).call)).toEqual({ kind: "unknown" });
    expect(await probeWireApis(BASE, {}, "m", provider({ completions: 400, responses: 429 }).call)).toEqual({ kind: "unknown" });
  });

  test("a refusal of Chat Completions that names the Responses API decides, though the Responses probe was refused or not answered", async () => {
    const refusal = JSON.stringify({ error: { message: "This model only supports the Responses API" } });
    for (const responses of [{ status: 400, body: '{"error":{"message":"Unsupported parameter"}}' }, null]) {
      const call = async (request: ProviderCall): Promise<ProviderAnswer> => {
        if (!request.url.pathname.endsWith("/responses")) return { kind: "answer", status: 400, body: refusal };
        return responses === null ? { kind: "failed", reason: "it did not answer in time" } : { kind: "answer", ...responses };
      };

      expect(await probeWireApis(BASE, {}, "gpt-6-luna", call)).toEqual({ kind: "answered", works: ["responses"] });
    }
  });

  test("a refusal that only mentions the Responses API in passing decides nothing", async () => {
    const call = async (): Promise<ProviderAnswer> => ({
      kind: "answer",
      status: 404,
      body: JSON.stringify({ error: { message: "Model not found; see the Responses API docs" } }),
    });

    expect(await probeWireApis(BASE, {}, "m", call)).toEqual({ kind: "answered", works: [] });
  });
});
