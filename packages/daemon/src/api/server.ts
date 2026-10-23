import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ApiResult, DaemonInfo, ErrorCode, Health } from "@trackwall/protocol";
import { DomainError } from "../errors.ts";
import type { Facade } from "../facade.ts";
import { hasValidToken, OriginPolicy } from "./guard.ts";
import { attachPtySockets } from "./pty-socket.ts";
import { postRoutes } from "./routes.ts";
import { serveStatic } from "./static.ts";

export interface ApiOptions {
  token: string;
  version: string;
  info: () => DaemonInfo;
  onShutdown: () => void;
  facade: Facade;
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
  internal: 500,
};

/** Ciała żądań to małe obiekty JSON; większe są odrzucane, zanim trafią do pamięci w całości. */
const MAX_BODY_BYTES = 64 * 1024;

/** HTTP API daemona na `127.0.0.1` (§5.2). `port: 0` wybiera losowy wolny port. */
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
  const closePtySockets = attachPtySockets(server, { token: options.token, facade: options.facade, policy: () => policy });
  return {
    server,
    port: boundPort,
    close: () =>
      new Promise<void>((resolve) => {
        closePtySockets();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
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

  if (path.startsWith("/api/")) return handleApi(req, res, path, o);
  if (o.uiDir && (req.method === "GET" || req.method === "HEAD")) return serveStatic(o.uiDir, path, res);
  return fail(res, "not_found", `no route ${req.method} ${path}`);
}

/** Trasy `/api/*`: poza `/api/health` każda wymaga tokenu. */
async function handleApi(req: IncomingMessage, res: ServerResponse, path: string, o: ApiOptions): Promise<void> {
  if (path === "/api/health" && req.method === "GET") {
    return ok<Health>(res, { status: "ok", version: o.version });
  }
  if (!hasValidToken(req, o.token)) return fail(res, "unauthorized", "missing or invalid token");
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
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new DomainError("bad_request", `ciało żądania większe niż ${MAX_BODY_BYTES} bajtów`);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new DomainError("bad_request", "ciało żądania nie jest poprawnym JSON-em");
  }
}

/** Ciało POST bez treści musi zostać odczytane, żeby połączenie keep-alive się nie zawiesiło. */
async function drain(req: IncomingMessage): Promise<void> {
  for await (const _ of req) {
    // celowo puste
  }
}
