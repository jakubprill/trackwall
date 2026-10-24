import { Client, StreamableHTTPClientTransport, type VersionNegotiationOptions } from "@modelcontextprotocol/client";
import { loopbackRequest } from "../../src/infra/loopback.ts";
import { MCP_PATH } from "../../src/mcp/endpoint.ts";

/**
 * Prawdziwy klient MCP z SDK (§10) połączony przez Streamable HTTP z daemonem na `port`. `fetch` idzie przez
 * `loopbackRequest`, bo `fetch` w Bun kieruje 127.0.0.1 przez `HTTP_PROXY` (AGENTS.md, Windows pierwszy).
 */
export async function connectHttpClient(port: number, token: string, versionNegotiation?: VersionNegotiationOptions): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${MCP_PATH}`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
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
