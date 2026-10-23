import type { IncomingMessage, ServerResponse } from "node:http";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { MCP_SERVER_NAME, mcpTools } from "@trackwall/protocol";
import { readBody } from "../api/body.ts";
import { TOOL_REGISTRATIONS, type ToolContext } from "./tools.ts";

/**
 * Serwer MCP daemona w transporcie Streamable HTTP (§5.3, ADR-24), bez sesji: każde żądanie dostaje świeży
 * `McpServer` z tymi samymi narzędziami, bo narzędzia tylko czytają fasadę i nie ma czego trzymać między żądaniami.
 * SDK obsługuje i rewizję 2026-07-28, i starsze klienty z `initialize` (bezstanowo). Host, Origin i token sprawdza
 * wcześniej `handle()` w `api/server.ts`, jak dla każdej trasy (AGENTS.md, Bezpieczeństwo).
 */

/** Ścieżka serwera MCP: ten sam port, ochrona `Host`/`Origin` i token co API (§5.2). */
export const MCP_PATH = "/mcp";

/** Żądania MCP to małe obiekty JSON-RPC; `initialize` z możliwościami klienta mieści się z dużym zapasem. */
const MAX_REQUEST_BYTES = 256 * 1024;

const INSTRUCTIONS =
  `Trackwall zna repo z folderu z projektami użytkownika. Zacznij od ${mcpTools.listRepos.name}; szczegóły jednego ` +
  `repo (README, ostatnie commity, taski mise) daje ${mcpTools.getRepo.name}. Narzędzia tylko czytają.`;

export interface McpEndpoint {
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  close: () => Promise<void>;
}

export function createMcpEndpoint(o: ToolContext & { version: string }): McpEndpoint {
  const handler = createMcpHandler(
    () => {
      const server = new McpServer({ name: MCP_SERVER_NAME, version: o.version }, { instructions: INSTRUCTIONS });
      for (const register of TOOL_REGISTRATIONS) register(server, o);
      return server;
    },
    { onerror: (err) => o.log(`żądanie odrzucone: ${err.message}`), maxRequestBodySize: MAX_REQUEST_BYTES },
  );
  return {
    handle: async (req, res) => {
      // Rozłączony klient przerywa żądanie także w SDK (`request.signal`), nie tylko strumień odpowiedzi.
      const aborted = new AbortController();
      res.once("close", () => {
        if (!res.writableFinished) aborted.abort();
      });
      await send(res, await handler.fetch(await toWebRequest(req, aborted.signal)));
    },
    close: () => handler.close(),
  };
}

/** `IncomingMessage` jako `Request` ze standardu Fetch, którego oczekuje SDK; adres zawsze z loopbacku. */
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
 * Odpowiedź SDK (JSON albo strumień SSE) przepisana do `ServerResponse`; rozłączony klient przerywa strumień, a błąd
 * strumienia zrywa połączenie, żeby klient nie czekał na koniec odpowiedzi, która nie przyjdzie.
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
