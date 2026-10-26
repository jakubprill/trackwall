import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport, type VersionNegotiationOptions } from "@modelcontextprotocol/client";
import { loopbackRequest } from "../../src/infra/loopback.ts";
import { MCP_PATH, SESSION_TOKEN_HEADER } from "../../src/mcp/endpoint.ts";

/**
 * A real MCP client from the SDK (§10) connected over Streamable HTTP to the daemon on `port`. `fetch` goes through
 * `loopbackRequest`, because `fetch` in Bun routes 127.0.0.1 through `HTTP_PROXY` (AGENTS.md, Windows first). `headers`
 * adds headers to every request, e.g. the session token, which the Stdio bridge adds in a Trackwall session.
 */
export async function connectHttpClient(
  port: number,
  token: string,
  versionNegotiation?: VersionNegotiationOptions,
  headers: Record<string, string> = {},
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${MCP_PATH}`), {
    requestInit: { headers: { authorization: `Bearer ${token}`, ...headers } },
    fetch: loopbackFetch(port),
  });
  const client = new Client({ name: "trackwall-test", version: "1" }, { versionNegotiation });
  await client.connect(transport);
  return client;
}

function loopbackFetch(port: number) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = Object.fromEntries(new Headers(init?.headers));
    const res = await loopbackRequest(port, url.pathname, {
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
      timeoutMs: 30_000,
    });
    const responseHeaders = new Headers();
    for (const [name, value] of Object.entries(res.headers)) if (typeof value === "string") responseHeaders.set(name, value);
    const noBody = res.status === 202 || res.status === 204;
    return new Response(noBody ? null : res.body, { status: res.status, headers: responseHeaders });
  };
}

/**
 * The MCP client of a Trackwall session's agent, as its Stdio bridge connects: the daemon token and the session token
 * from the file in the session directory under `home`.
 */
export function connectSessionClient(port: number, token: string, home: string, session: string): Promise<Client> {
  const sessionToken = readFileSync(join(home, "sessions", session, "session-token"), "utf8");
  return connectHttpClient(port, token, undefined, { [SESSION_TOKEN_HEADER]: sessionToken });
}
