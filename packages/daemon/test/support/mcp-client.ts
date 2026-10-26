import { Client, StreamableHTTPClientTransport, type VersionNegotiationOptions } from "@modelcontextprotocol/client";
import { WAIT_MAX_SECONDS } from "@trackwall/protocol";
import { loopbackRequest } from "../../src/infra/loopback.ts";
import { MCP_PATH, SESSION_TOKEN_HEADER } from "../../src/mcp/endpoint.ts";
import { sessionToken } from "./session-token.ts";

/**
 * A real MCP client from the SDK (§10) connected over Streamable HTTP to the daemon on `port`. `fetch` goes through
 * `loopbackRequest`, because `fetch` in Bun routes 127.0.0.1 through `HTTP_PROXY` (AGENTS.md, Windows first). `headers`
 * adds headers to every request, e.g. the session token, which a Trackwall session's MCP entry carries.
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

/**
 * How long one request may take: the longest wait a tool may be asked for plus the work around it (a service slice is
 * planned before its wait and its log errors read after it), so a waiting call ends on its own time limit, not this one.
 * A caller of such a tool passes it to `callTool` too, whose own limit is 60 s.
 */
export const MCP_CALL_LIMIT_MS = (WAIT_MAX_SECONDS + 30) * 1000;

function loopbackFetch(port: number) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = Object.fromEntries(new Headers(init?.headers));
    const res = await loopbackRequest(port, url.pathname, {
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
      timeoutMs: MCP_CALL_LIMIT_MS,
    });
    const responseHeaders = new Headers();
    for (const [name, value] of Object.entries(res.headers)) if (typeof value === "string") responseHeaders.set(name, value);
    const noBody = res.status === 202 || res.status === 204;
    return new Response(noBody ? null : res.body, { status: res.status, headers: responseHeaders });
  };
}

/**
 * The MCP client of a Trackwall session's agent, as its Copilot CLI connects: the daemon token and the session token
 * from the session's MCP configuration under `home`.
 */
export function connectSessionClient(port: number, token: string, home: string, session: string): Promise<Client> {
  return connectHttpClient(port, token, undefined, { [SESSION_TOKEN_HEADER]: sessionToken(home, session) });
}
