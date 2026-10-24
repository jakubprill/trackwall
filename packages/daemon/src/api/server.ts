import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ApiResult, DaemonInfo, ErrorCode, Health } from "@trackwall/protocol";
import type { Facade } from "../facade.ts";
import { DomainError } from "../infra/errors.ts";
import { MCP_PATH, type McpEndpoint, SESSION_TOKEN_HEADER } from "../mcp/endpoint.ts";
import { readBody } from "./body.ts";
import type { EventHub } from "./event-hub.ts";
import { eventSocketRoute } from "./event-socket.ts";
import { hasValidToken, OriginPolicy } from "./guard.ts";
import { ptySocketRoute } from "./pty-socket.ts";
import { postRoutes } from "./routes.ts";
import { attachSockets } from "./sockets.ts";
import { serveStatic } from "./static.ts";

export interface ApiOptions {
  token: string;
  version: string;
  info: () => DaemonInfo;
  onShutdown: () => void;
  facade: Facade;
  /** Serwer MCP (§5.3) pod `/mcp`; trasa i ochrona są tu, narzędzia w `mcp/`. Zamykany razem z serwerem API. */
  mcp: McpEndpoint;
  /** Zdarzenia dla WebSocketu `/ws` (§5.2, ADR-36); zamykane razem z serwerem API. */
  events: EventHub;
  uiDir?: string;
  /** Dodatkowe originy przeglądarki z dostępem do API, np. serwer Vite przy `tauri dev`. */
  allowOrigins?: readonly string[];
}

export interface ApiServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

const STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden_origin: 403,
  not_found: 404,
  bad_request: 400,
  repo_unavailable: 409,
  projects_dir_unavailable: 409,
  invalid_config: 500,
  mise_unavailable: 409,
  stop_unconfirmed: 500,
  agent_unavailable: 409,
  unsaved_changes: 409,
  service_unavailable: 409,
  internal: 500,
};

/** Ciała żądań to małe obiekty JSON; większe są odrzucane, zanim trafią do pamięci w całości. */
const MAX_BODY_BYTES = 64 * 1024;

/** HTTP API daemona na `127.0.0.1` z WebSocketami (§5.2) i serwer MCP pod `/mcp` (§5.3). `port: 0` wybiera losowy wolny port. */
export async function startApi(options: ApiOptions, port = 0): Promise<ApiServer> {
  let policy: OriginPolicy | undefined;
  const server = createServer((req, res) => {
    if (!policy) return void res.destroy();
    handle(req, res, options, policy).catch((err: unknown) => {
      if (err instanceof DomainError && !res.headersSent) return fail(res, err.code, err.message);
      process.stderr.write(`[api] ${req.method} ${req.url}: ${String(err)}\n`);
      if (!res.headersSent) send(res, 500, { ok: false, error: { code: "internal", message: "internal error" } });
      else res.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const boundPort = (server.address() as AddressInfo).port;
  policy = new OriginPolicy(boundPort, options.allowOrigins);
  const closeSockets = attachSockets(server, {
    token: options.token,
    policy: () => policy,
    routes: [eventSocketRoute(options.events), ptySocketRoute(options.facade)],
  });
  return {
    server,
    port: boundPort,
    close: async () => {
      closeSockets();
      options.events.close();
      await options.mcp.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

async function handle(req: IncomingMessage, res: ServerResponse, o: ApiOptions, policy: OriginPolicy): Promise<void> {
  const origin = req.headers.origin;
  if (!policy.isAllowedHost(req.headers.host) || !policy.isAllowedOrigin(origin)) {
    return fail(res, "forbidden_origin", "host or origin is not allowed");
  }
  const allowOrigin = policy.corsOrigin(origin);
  if (allowOrigin) {
    res.setHeader("access-control-allow-origin", allowOrigin);
    res.setHeader("vary", "origin");
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-max-age": "600",
    });
    return void res.end();
  }

  // Publiczne są tylko `GET /api/health` i statyczne pliki UI; reszta API i MCP przechodzi jedno sprawdzenie tokenu.
  if (path === "/api/health" && req.method === "GET") return ok<Health>(res, { status: "ok", version: o.version });
  const api = path.startsWith("/api/");
  if ((api || path === MCP_PATH) && !hasValidToken(req, o.token)) return fail(res, "unauthorized", "missing or invalid token");
  if (api) return handleApi(req, res, path, o);
  if (path === MCP_PATH) return handleMcp(req, res, o);
  if (o.uiDir && (req.method === "GET" || req.method === "HEAD")) return serveStatic(o.uiDir, path, res);
  return fail(res, "not_found", `no route ${req.method} ${path}`);
}

/** Trasy `/api/*` z tokenem, już sprawdzonym. */
async function handleApi(req: IncomingMessage, res: ServerResponse, path: string, o: ApiOptions): Promise<void> {
  if (path === "/api/daemon/info" && req.method === "GET") return ok<DaemonInfo>(res, o.info());
  if (path === "/api/daemon/shutdown" && req.method === "POST") {
    await drain(req);
    ok(res, { stopping: true as const });
    res.once("finish", () => setImmediate(o.onShutdown));
    return;
  }
  const post = req.method === "POST" ? postRoutes.get(path) : undefined;
  if (post) return ok(res, await post(o.facade, await readJson(req)));
  return fail(res, "not_found", `no route ${req.method} ${path}`);
}

/** MCP z tokenem daemona; nagłówek tokenu sesji mówi, która sesja Trackwall woła (ADR-39), a nieznany token to odmowa. */
function handleMcp(req: IncomingMessage, res: ServerResponse, o: ApiOptions): Promise<void> | void {
  const token = req.headers[SESSION_TOKEN_HEADER];
  if (token === undefined) return o.mcp.handle(req, res, null);
  const caller = typeof token === "string" ? o.facade.agents.callerSession(token) : undefined;
  if (caller === undefined) return fail(res, "unauthorized", "unknown session token: this Trackwall session has ended");
  return o.mcp.handle(req, res, caller);
}

function ok<T>(res: ServerResponse, data: T): void {
  send(res, 200, { ok: true, data } satisfies ApiResult<T>);
}

function fail(res: ServerResponse, code: ErrorCode, message: string): void {
  send(res, STATUS[code], { ok: false, error: { code, message } } satisfies ApiResult<never>);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** Ciało JSON żądania; puste ciało to `{}`. */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const text = (await readBody(req, MAX_BODY_BYTES)).toString("utf8");
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new DomainError("bad_request", "request body is not valid JSON");
  }
}

/** Ciało POST bez treści musi zostać odczytane, żeby połączenie keep-alive się nie zawiesiło. */
async function drain(req: IncomingMessage): Promise<void> {
  for await (const _ of req) {
    // celowo puste
  }
}
