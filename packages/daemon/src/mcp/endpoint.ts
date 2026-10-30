import type { IncomingMessage, ServerResponse } from "node:http";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { type HttpEndpoint, MCP_INSTRUCTIONS, MCP_SERVER_NAME } from "@trackwall/protocol";
import { readBody } from "../api/body.ts";
import { TOOL_REGISTRATIONS, type ToolContext } from "./tools.ts";

/**
 * The daemon's MCP server in the Streamable HTTP transport (§5.3, ADR-24), without MCP sessions: every request gets a fresh
 * `McpServer` with the same tools, because the facade holds the state, not the server. The SDK handles both revision 2026-07-28
 * and older clients with `initialize` (statelessly). `handle()` in `api/server.ts` checks the Host, Origin and token
 * earlier, as for every route (AGENTS.md, Security): the daemon token, or a Trackwall session's own token alone (ADR-138),
 * by which the tools also know which session is calling (ADR-39).
 */

/** The MCP server's path: the same port, `Host`/`Origin` protection and token as the API (§5.2). */
export const MCP_PATH = "/mcp";

/**
 * The header with the session token that a Trackwall session's MCP configuration sends (ADR-39, ADR-89). Without it the
 * caller is an agent outside Trackwall; with an unknown token (an ended session) the request is rejected, so that the
 * session does not look foreign.
 */
export const SESSION_TOKEN_HEADER = "x-trackwall-session-token";

/**
 * `path` on a daemon whose API listens on `port`, as a Trackwall session reaches it: only its session token, which opens
 * nothing but the MCP server and the hooks (ADR-138), so the session's files never hold the daemon token.
 */
export function sessionRequest(port: number, sessionToken: string, path: string): HttpEndpoint {
  return { url: `http://127.0.0.1:${port}${path}`, headers: { [SESSION_TOKEN_HEADER]: sessionToken } };
}

/** The MCP server of a daemon whose API listens on `port`, as a Trackwall session reaches it. */
export function sessionMcpRequest(port: number, sessionToken: string): HttpEndpoint {
  return sessionRequest(port, sessionToken, MCP_PATH);
}

/** MCP requests are small JSON-RPC objects; `initialize` with the client's capabilities fits with a large margin. */
const MAX_REQUEST_BYTES = 256 * 1024;

export interface McpEndpoint {
  /** An authorised request from session `caller` (`null`: an agent outside Trackwall), already recognised by its session token. */
  handle: (req: IncomingMessage, res: ServerResponse, caller: string | null) => Promise<void>;
  close: () => Promise<void>;
}

export function createMcpEndpoint(o: ToolContext & { version: string }): McpEndpoint {
  const handler = createMcpHandler(
    // The calling session comes from `handle` as `authInfo.clientId`: the SDK's only path from the request to the server factory.
    ({ authInfo }) => {
      const server = new McpServer({ name: MCP_SERVER_NAME, version: o.version }, { instructions: MCP_INSTRUCTIONS });
      const caller = authInfo?.clientId ?? null;
      for (const register of TOOL_REGISTRATIONS) register(server, { ...o, caller });
      return server;
    },
    { onerror: (err) => o.log(`request rejected: ${err.message}`), maxRequestBodySize: MAX_REQUEST_BYTES },
  );
  return {
    handle: async (req, res, caller) => {
      // A disconnected client aborts the request in the SDK too (`request.signal`), not only the response stream.
      const aborted = new AbortController();
      res.once("close", () => {
        if (!res.writableFinished) aborted.abort();
      });
      // `token` is required in the SDK, but the server does not read it; the session token itself never leaves `handle()` in the API.
      const authInfo = caller === null ? undefined : { token: "", clientId: caller, scopes: [] };
      await send(res, await handler.fetch(await toWebRequest(req, aborted.signal), { authInfo }));
    },
    close: () => handler.close(),
  };
}

/** `IncomingMessage` as the Fetch standard's `Request` the SDK expects; the address always from loopback. */
async function toWebRequest(req: IncomingMessage, signal: AbortSignal): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(name, v);
  }
  const method = req.method ?? "GET";
  const body = method === "GET" || method === "HEAD" ? undefined : new Uint8Array(await readBody(req, MAX_REQUEST_BYTES));
  return new Request(new URL(req.url ?? "/", "http://127.0.0.1").href, { method, headers, body, signal });
}

/**
 * The SDK's response (JSON or an SSE stream) copied to `ServerResponse`; a disconnected client aborts the stream, and a stream
 * error breaks the connection, so that the client does not wait for the end of a response that will not come.
 */
async function send(res: ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) return void res.end();
  const reader = response.body.getReader();
  res.once("close", () => void reader.cancel().catch(() => {}));
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || res.destroyed) break;
      res.write(value);
    }
    res.end();
  } catch (err) {
    res.destroy(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
}
