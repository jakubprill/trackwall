import type { WireApi } from "@trackwall/protocol";
import { COPILOT_PROVIDER_ENV } from "../../infra/copilot-provider-env.ts";
import { envKey } from "../../infra/env-key.ts";

/**
 * Where a session's Copilot CLI sends its model requests and with which credentials, read from the session profile's
 * environment as Copilot CLI reads it (`copilot help environment`, ADR-136, ADR-194): `COPILOT_PROVIDER_BASE_URL`,
 * `COPILOT_PROVIDER_BEARER_TOKEN` before `COPILOT_PROVIDER_API_KEY` as a bearer token, and the extra
 * `COPILOT_PROVIDER_HEADERS`, with the format `COPILOT_PROVIDER_WIRE_API` and `COPILOT_PROVIDER_TRANSPORT`. Only an OpenAI-compatible provider (`COPILOT_PROVIDER_TYPE` `openai`, the default) has the
 * `GET /models` list and the format probes of ADR-197 asked here, and a key from `COPILOT_PROVIDER_API_KEY_COMMAND` is not run: the daemon does not run a
 * command named in a file an agent might reach (§1.2).
 */

export type ProviderRequest =
  | { kind: "none" }
  | {
      kind: "request";
      /** The provider's base address, without a trailing slash; its paths (`/models`, `/chat/completions`) go after it. */
      base: URL;
      headers: Record<string, string>;
      /** The format the profile names, Copilot CLI's default `completions` when it names none. */
      wireApi: WireApi;
      /** Whether Copilot CLI talks to the provider over HTTP, its default; WebSockets are not probed here. */
      http: boolean;
    }
  | { kind: "unsupported"; problem: string };

const {
  baseUrl: BASE_URL,
  type: TYPE,
  bearerToken: BEARER_TOKEN,
  apiKey: API_KEY,
  apiKeyCommand: API_KEY_COMMAND,
  headers: HEADERS,
  wireApi: WIRE_API,
  transport: TRANSPORT,
} = COPILOT_PROVIDER_ENV;

/** An HTTP field name (RFC 9110 token). */
const FIELD_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** A character that would end a header line or the request head; such a value is never written into the request. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are what the pattern looks for.
const CONTROL = /[\x00-\x1f\x7f]/;
/** Fields the request itself sets; one from the profile would make the request say two things. */
const OWN_FIELDS = new Set(["host", "accept", "accept-encoding", "connection", "content-length", "content-type", "transfer-encoding"]);

/** The models request of the profile's provider; `none` when the profile names no provider. */
export function providerRequest(env: NodeJS.ProcessEnv, profile: string): ProviderRequest {
  const value = (name: string) => env[envKey(env, name)]?.trim() || undefined;
  const base = value(BASE_URL);
  if (base === undefined) return { kind: "none" };
  const type = (value(TYPE) ?? "openai").toLowerCase();
  if (type !== "openai")
    return { kind: "unsupported", problem: `Trackwall lists the models only of an OpenAI-compatible provider, and ${TYPE} is ${type}.` };
  if (!URL.canParse(base)) return { kind: "unsupported", problem: `${BASE_URL} of the session profile ${profile} is not an address.` };
  const url = new URL(base);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return { kind: "unsupported", problem: `${BASE_URL} of the session profile ${profile} is not an http or https address.` };
  url.pathname = url.pathname.replace(/\/+$/, "");
  const token = value(BEARER_TOKEN) ?? (value(API_KEY_COMMAND) === undefined ? value(API_KEY) : undefined);
  if (token === undefined && value(API_KEY_COMMAND) !== undefined)
    return {
      kind: "unsupported",
      problem: `The key comes from ${API_KEY_COMMAND}, which Trackwall does not run, so it cannot ask the provider for its models.`,
    };
  if (token !== undefined && CONTROL.test(token))
    return {
      kind: "unsupported",
      problem: `The key of the session profile ${profile} has a line break or another control character in it.`,
    };
  const wireApi = value(WIRE_API)?.toLowerCase() === "responses" ? "responses" : "completions";
  return {
    kind: "request",
    base: url,
    headers: { ...extraHeaders(value(HEADERS)), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    wireApi,
    http: (value(TRANSPORT) ?? "http").toLowerCase() === "http",
  };
}

/** `Name: Value` pairs, one per line or separated by a literal `\n`; a pair that is not a valid field is left out. */
function extraHeaders(text: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of (text ?? "").split(/\r?\n|\\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!FIELD_NAME.test(name) || OWN_FIELDS.has(name.toLowerCase()) || CONTROL.test(value.replace(/\t/g, " "))) continue;
    headers[name] = value;
  }
  return headers;
}

/** The provider's address for `path` (`/models`): the base's path with it after, its query kept. */
export function providerUrl(base: URL, path: string): URL {
  const url = new URL(base.href);
  url.pathname = `${base.pathname}${path}`;
  return url;
}
