import { WireApi } from "@trackwall/protocol";
import type { ProviderAnswer, ProviderCall } from "./provider-call.ts";
import { providerUrl } from "./provider-request.ts";

/**
 * Which format a model of the provider answers in (ADR-197): one smallest request in each of Copilot CLI's two
 * formats, `POST /chat/completions` and `POST /responses`, with a one-word prompt and the fewest output tokens a
 * provider takes, sent at once. A provider refuses the other format at once with a 400 ("this model only supports the
 * Responses API"), so the probe costs at most two tiny answers, once per model. `/models` does not say which format a
 * model needs, so asking is the only way to know it.
 */

export type WireApiProbe =
  /** Only these formats answered; `[]` when none did. */
  | { kind: "answered"; works: WireApi[] }
  /** The provider could not be reached, or answered neither request with a status; nothing is learned. */
  | { kind: "unknown" };

/** The request of each format for `model`. */
function probeBody(wireApi: WireApi, model: string): { path: string; body: unknown } {
  return wireApi === "completions"
    ? // `max_tokens` is refused by reasoning models that do take chat completions, `max_completion_tokens` by none.
      {
        path: "/chat/completions",
        body: { model, messages: [{ role: "user", content: "ping" }], max_completion_tokens: 16, stream: false },
      }
    : // Some providers refuse fewer than 16 output tokens of the Responses API.
      { path: "/responses", body: { model, input: "ping", max_output_tokens: 16, stream: false } };
}

export async function probeWireApis(
  base: URL,
  headers: Readonly<Record<string, string>>,
  model: string,
  call: (request: ProviderCall) => Promise<ProviderAnswer>,
): Promise<WireApiProbe> {
  const answers = await Promise.all(
    WireApi.options.map(async (wireApi) => {
      const { path, body } = probeBody(wireApi, model);
      return { wireApi, answer: await call({ url: providerUrl(base, path), headers, body }) };
    }),
  );
  if (answers.some(({ answer }) => answer.kind === "failed")) return { kind: "unknown" };
  // A 5xx or a 429 says nothing about the format; only a 2xx and a 4xx other than a rate limit do.
  const decided = answers.every(({ answer }) => answer.kind === "answer" && answer.status < 500 && answer.status !== 429);
  if (!decided) return { kind: "unknown" };
  const works = answers
    .filter(({ answer }) => answer.kind === "answer" && answer.status >= 200 && answer.status < 300)
    .map((a) => a.wireApi);
  return { kind: "answered", works };
}
