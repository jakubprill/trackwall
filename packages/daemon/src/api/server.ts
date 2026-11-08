import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  API_BODY_MAX_BYTES,
  type ApiResult,
  DAEMON_INFO_PATH,
  type DaemonInfo,
  DOWNLOAD_PATH,
  DROP_NAME_HEADER,
  DROP_PATH,
  type DroppedFile,
  type ErrorCode,
  HEALTH_PATH,
  type Health,
} from "@trackwall/protocol";
import type { Facade } from "../facade.ts";
import { DomainError } from "../infra/errors.ts";
import { MCP_PATH, type McpEndpoint, SESSION_TOKEN_HEADER } from "../mcp/endpoint.ts";
import { readBody } from "./body.ts";
import { conversationSocketRoute } from "./conversation-socket.ts";
import type { EventHub } from "./event-hub.ts";
import { eventSocketRoute } from "./event-socket.ts";
import { downloadRequest, sendDownload } from "./file-download.ts";
import { droppedBody, droppedName, refuseOversized } from "./file-drop.ts";
import { bearerToken, OriginPolicy, tokenMatches } from "./guard.ts";
import { HOOKS_PATH, handleHook } from "./hooks.ts";
import { sessionSocketRoute, terminalSocketRoute } from "./pty-socket.ts";
import { postRoutes } from "./routes.ts";
import { attachSockets } from "./sockets.ts";
import { serveStatic } from "./static.ts";

export interface ApiOptions {
  token: string;
  version: string;
  info: () => DaemonInfo;
  onShutdown: () => void;
  facade: Facade;
  /** The MCP server (§5.3) under `/mcp`; the route and protection are here, the tools in `mcp/`. Closed together with the API server. */
  mcp: McpEndpoint;
  /** Events for the `/ws` WebSocket (§5.2, ADR-36); closed together with the API server. */
  events: EventHub;
  uiDir?: string;
  /** Extra browser origins with access to the API, e.g. the Vite server during `tauri dev`. */
  allowOrigins?: readonly string[];
}

export interface ApiServer {
  server: Server;
  port: number;
  /** This start's random id, which `GET /api/health` reports (ADR-161) and viewer access writes next to its token (ADR-221). */
  instance: string;
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
  dialog_changed: 409,
  service_unavailable: 409,
  no_desktop: 409,
  terminal_unavailable: 409,
  internal: 500,
};

/**
 * The daemon's HTTP API on `127.0.0.1` with WebSockets (§5.2) and the MCP server under `/mcp` (§5.3); `port: 0` picks a random
 * free port.
 */
export async function startApi(options: ApiOptions, port = 0): Promise<ApiServer> {
  let policy: OriginPolicy | undefined;
  const instance = randomUUID();
  const server = createServer((req, res) => {
    if (!policy) return void res.destroy();
    handle(req, res, options, policy, instance).catch((err: unknown) => {
      if (err instanceof DomainError && !res.headersSent) return fail(res, err.code, err.message);
      process.stderr.write(`[api] ${req.method} ${req.url}: ${String(err)}\n`);
      options.facade.errorJournal.recordDaemonError(journalArea(req.url), err);
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
    routes: [
      eventSocketRoute(options.events),
      sessionSocketRoute(options.facade),
      terminalSocketRoute(options.facade),
      conversationSocketRoute(options.facade),
    ],
  });
  return {
    server,
    port: boundPort,
    instance,
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

async function handle(req: IncomingMessage, res: ServerResponse, o: ApiOptions, policy: OriginPolicy, instance: string): Promise<void> {
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
      "access-control-allow-headers": `authorization, content-type, ${DROP_NAME_HEADER}`,
      "access-control-max-age": "600",
    });
    return void res.end();
  }

  // Only `GET /api/health` and the static UI files are public; the rest of the API, MCP and the hooks pass one token check.
  if (path === HEALTH_PATH && req.method === "GET") return ok<Health>(res, { status: "ok", version: o.version, instance });
  const route = protectedRoute(req, res, path, o);
  if (route) {
    const caller = authenticate(req, route.opensWith, o);
    return "refused" in caller ? fail(res, "unauthorized", caller.refused) : route.run(caller.session);
  }
  if (o.uiDir && (req.method === "GET" || req.method === "HEAD")) return serveStatic(o.uiDir, path, res);
  return fail(res, "not_found", `no route ${req.method} ${path}`);
}

/**
 * Which token besides the daemon token opens a route: a session token on a route a session uses (ADR-138), the viewer
 * token on the viewer's session list (ADR-221), or none.
 */
type RouteTokens = "daemon" | "session" | "viewer";

/** A route behind the token and how `authenticate` treats it. */
interface ProtectedRoute {
  opensWith: RouteTokens;
  /** Handles the request from the calling Trackwall session, `null` for the daemon token without a session token. */
  run: (session: string | null) => Promise<void> | void;
}

/** The routes behind the token: the API, MCP and the session plugin's hooks (ADR-88); `undefined` for any other path. */
function protectedRoute(req: IncomingMessage, res: ServerResponse, path: string, o: ApiOptions): ProtectedRoute | undefined {
  if (path.startsWith("/api/")) return { opensWith: postRoutes.get(path)?.opensWith ?? "daemon", run: () => handleApi(req, res, path, o) };
  if (path === MCP_PATH) return { opensWith: "session", run: (session) => o.mcp.handle(req, res, session) };
  if (path.startsWith(HOOKS_PATH)) {
    return {
      opensWith: "session",
      run: (session) => handleHook(req, res, path, session, (...args) => o.facade.agents.receiveHook(...args)),
    };
  }
  return undefined;
}

/**
 * Who calls a protected route, once, before the route reads the body. The daemon token opens every route; on a
 * session-scoped route a session token the daemon issued is enough and says which session calls (ADR-39), so the files
 * of a session, which its agent can read, hold no token for the API (ADR-138). An unknown session token there is
 * refused even with the daemon token, so an ended session does not look like an agent outside Trackwall. The viewer
 * token opens the viewer's session list alone and only while viewer access is on (ADR-221).
 */
function authenticate(req: IncomingMessage, opensWith: RouteTokens, o: ApiOptions): { session: string | null } | { refused: string } {
  const sessionToken = opensWith === "session" ? req.headers[SESSION_TOKEN_HEADER] : undefined;
  if (sessionToken === undefined) {
    const given = bearerToken(req);
    const opened =
      given !== undefined && (tokenMatches(given, o.token) || (opensWith === "viewer" && o.facade.viewerAccess.accepts(given)));
    return opened ? { session: null } : { refused: "missing or invalid token" };
  }
  const session = typeof sessionToken === "string" ? o.facade.agents.callerSession(sessionToken) : undefined;
  return session === undefined ? { refused: "unknown session token: this Trackwall session has ended" } : { session };
}

/**
 * Where a failed request goes in the error journal (ADR-94): the action's path when it is one of the API's, else one area
 * for all the rest, so a path a client made up never reaches the journal. Plain string work: the request's address may be
 * one `URL` refuses, which is how this request may have failed.
 */
function journalArea(url: string | undefined): string {
  const path = (url ?? "").split("?")[0] ?? "";
  if (postRoutes.has(path) || path === DOWNLOAD_PATH || path === DROP_PATH) return `api:${path}`;
  return path.startsWith(HOOKS_PATH) ? "api:hooks" : "api:other";
}

/** `/api/*` routes with the token, already checked. */
async function handleApi(req: IncomingMessage, res: ServerResponse, path: string, o: ApiOptions): Promise<void> {
  if (path === DAEMON_INFO_PATH && req.method === "GET") return ok<DaemonInfo>(res, o.info());
  if (path === "/api/daemon/shutdown" && req.method === "POST") {
    await drain(req);
    ok(res, { stopping: true as const });
    res.once("finish", () => setImmediate(o.onShutdown));
    return;
  }
  if (path === DOWNLOAD_PATH && req.method === "POST")
    return sendDownload(res, await o.facade.folderFiles.download(downloadRequest(await readJson(req, API_BODY_MAX_BYTES))));
  if (path === DROP_PATH && req.method === "POST") return receiveDrop(req, res, o);
  const post = req.method === "POST" ? postRoutes.get(path) : undefined;
  // The token was checked before any of the body is read, so only the daemon's own clients send a large one.
  if (post) return ok(res, await post.run(o.facade, await readJson(req, post.maxBodyBytes)));
  return fail(res, "not_found", `no route ${req.method} ${path}`);
}

/** A dropped file (ADR-226); after a refusal the rest of the body is read and dropped, so the answer still reaches the client. */
async function receiveDrop(req: IncomingMessage, res: ServerResponse, o: ApiOptions): Promise<void> {
  try {
    const name = droppedName(req);
    refuseOversized(req, name);
    return ok<DroppedFile>(res, { path: await o.facade.droppedFiles.save(name, droppedBody(req)) });
  } catch (err) {
    req.resume();
    throw err;
  }
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

/** The request's JSON body, an empty one `{}`; one over `maxBytes` is rejected before it is held in memory in full. */
async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const text = (await readBody(req, maxBytes)).toString("utf8");
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new DomainError("bad_request", "request body is not valid JSON");
  }
}

/** A POST body without content must be read so that a keep-alive connection does not hang. */
async function drain(req: IncomingMessage): Promise<void> {
  for await (const _ of req) {
    // intentionally empty
  }
}
