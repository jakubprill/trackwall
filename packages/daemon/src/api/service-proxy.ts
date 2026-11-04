import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  request,
  type ServerResponse,
} from "node:http";
import { type AddressInfo, connect, type Socket } from "node:net";
import { isServiceProxyOrigin, type ProxyTarget, serviceProxyAddress, serviceProxyTarget } from "@trackwall/protocol";
import { DomainError, messageOf } from "../infra/errors.ts";

/**
 * The service proxy (§5.6, ADR-189): a listener on `127.0.0.1`, apart from the API, that passes a browser's request to
 * the running service the name in `Host` stands for (`<repo>.localhost:<port>`, `<task>.<repo>.localhost:<port>`),
 * WebSockets included. In a dev container one forwarded port then opens every service on the user's computer.
 *
 * It guarantees: a request reaches only the port of a service Trackwall runs and found answering (`services.address`),
 * never the daemon's API or another port; a `Host` that is not a name under `localhost` on this port is refused, so a
 * page that rebinds its own domain to 127.0.0.1 reaches nothing; a request a page of another site sends (its `Origin`
 * is not a service behind this proxy) is refused, so a site the user visits cannot drive a service through it. No
 * token: the browser opens the address directly, as it would a forwarded port of the service.
 */

export interface ServiceProxyOptions {
  /** `0` picks a free port (tests). */
  port: number;
  /** Where the running service of `target` answers; a `DomainError` says why there is none. */
  address: (target: ProxyTarget) => Promise<{ host: string; port: number }>;
  log: (msg: string) => void;
}

export interface ServiceProxy {
  port: number;
  close: () => Promise<void>;
}

/** Headers of one connection, not of the request (RFC 9110 §7.6.1); the proxy's own connections set their own. */
const HOP_BY_HOP = ["connection", "keep-alive", "proxy-connection", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];

export async function startServiceProxy(o: ServiceProxyOptions): Promise<ServiceProxy> {
  let port = o.port;
  const upgraded = new Set<Socket>();
  const server = createServer((req, res) => {
    forward(req, res, port, o).catch((err: unknown) => {
      o.log(`service proxy: ${messageOf(err)}`);
      if (!res.headersSent) answer(res, 502, "Trackwall could not reach the service.");
      else res.destroy();
    });
  });
  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    upgraded.add(socket);
    socket.once("close", () => upgraded.delete(socket));
    upgrade(req, socket, head, port, o).catch((err: unknown) => {
      o.log(`service proxy: ${messageOf(err)}`);
      socket.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of upgraded) socket.destroy();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** The service a request may reach, or the status and sentence that refuse it. */
async function reach(
  req: IncomingMessage,
  port: number,
  o: ServiceProxyOptions,
): Promise<{ address: { host: string; port: number } } | { status: number; text: string }> {
  const target = serviceProxyTarget(req.headers.host, port);
  if (!target) {
    const example = serviceProxyAddress(port, { repo: "<repo>", task: null });
    return { status: 404, text: `Trackwall opens a running service at ${example}, with the repo's name in place of <repo>.` };
  }
  const origin = req.headers.origin;
  if (origin !== undefined && !isServiceProxyOrigin(origin, port))
    return { status: 403, text: "Trackwall passes no request from a page of another site to a service." };
  try {
    return { address: await o.address(target) };
  } catch (err) {
    if (err instanceof DomainError) return { status: 502, text: `${upperFirst(err.message)}. Start it in Trackwall, then reload.` };
    throw err;
  }
}

async function forward(req: IncomingMessage, res: ServerResponse, port: number, o: ServiceProxyOptions): Promise<void> {
  const reached = await reach(req, port, o);
  if ("status" in reached) return answer(res, reached.status, reached.text);
  const { address } = reached;
  const upstream = request(
    { host: address.host, port: address.port, method: req.method, path: req.url, headers: forwardedHeaders(req) },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.statusMessage, responseHeaders(up.headers, address.port, req.headers.host));
      up.pipe(res);
    },
  );
  upstream.once("error", (err) => {
    o.log(`service proxy: the service on port ${address.port}: ${err.message}`);
    if (!res.headersSent) answer(res, 502, "The service closed the connection. Look at its log in Trackwall.");
    else res.destroy();
  });
  // The browser went away before the answer ended: the service stops sending too.
  res.once("close", () => {
    if (!res.writableFinished) upstream.destroy();
  });
  req.pipe(upstream);
}

async function upgrade(req: IncomingMessage, socket: Socket, head: Buffer, port: number, o: ServiceProxyOptions): Promise<void> {
  const reached = await reach(req, port, o);
  if ("status" in reached) {
    socket.end(`HTTP/1.1 ${reached.status} ${reached.status === 404 ? "Not Found" : "Refused"}\r\nconnection: close\r\n\r\n`);
    return;
  }
  const upstream = connect({ host: reached.address.host, port: reached.address.port });
  upstream.once("connect", () => {
    upstream.write(upgradeHead(req));
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.once("error", () => socket.destroy());
  socket.once("error", () => upstream.destroy());
  upstream.once("close", () => socket.destroy());
  socket.once("close", () => upstream.destroy());
}

/**
 * The request's headers for the service: the browser's `Host` unchanged (a dev server checks it, an app builds links
 * from it), without the headers of the browser's connection, with where the request came from in `X-Forwarded-*`.
 */
function forwardedHeaders(req: IncomingMessage): OutgoingHttpHeaders {
  return { ...withoutHopByHop(req.headers), ...forwardedFor(req) };
}

function forwardedFor(req: IncomingMessage): Record<string, string> {
  const host = req.headers.host ?? "";
  const previous = req.headers["x-forwarded-for"];
  const client = req.socket.remoteAddress ?? "127.0.0.1";
  return {
    "x-forwarded-for": previous ? `${String(previous)}, ${client}` : client,
    "x-forwarded-host": host,
    "x-forwarded-proto": "http",
    "x-forwarded-port": host.slice(host.lastIndexOf(":") + 1),
  };
}

/** The raw start of a WebSocket handshake for the service: the browser's lines, which keep `Upgrade`, and `X-Forwarded-*`. */
function upgradeHead(req: IncomingMessage): string {
  const lines = [`${req.method} ${req.url} HTTP/1.1`];
  const raw = req.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i] ?? "";
    if (!name.toLowerCase().startsWith("x-forwarded-")) lines.push(`${name}: ${raw[i + 1]}`);
  }
  for (const [name, value] of Object.entries(forwardedFor(req))) lines.push(`${name}: ${value}`);
  return `${lines.join("\r\n")}\r\n\r\n`;
}

/**
 * The service's answer for the browser: without the headers of the service's connection, and with a redirect to the
 * service's own address (`http://localhost:8080/login`), which the user's computer cannot open, turned into one through
 * the proxy.
 */
function responseHeaders(headers: IncomingHttpHeaders, servicePort: number, host: string | undefined): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = { ...withoutHopByHop(headers) };
  if (typeof headers.location === "string" && host) out.location = throughProxy(headers.location, servicePort, host);
  return out;
}

/** `location` with the service's own loopback origin replaced by the proxy's; any other address stays as it is. */
export function throughProxy(location: string, servicePort: number, host: string): string {
  for (const name of ["localhost", "127.0.0.1", "[::1]"]) {
    const own = `http://${name}:${servicePort}`;
    if (location === own || location.startsWith(`${own}/`) || location.startsWith(`${own}?`))
      return `http://${host}${location.slice(own.length)}`;
  }
  return location;
}

function withoutHopByHop(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const named = String(headers.connection ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const drop = new Set([...HOP_BY_HOP, ...named]);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !drop.has(name)));
}

function answer(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(`${text}\n`);
}

function upperFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
