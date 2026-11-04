import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  request,
  type ServerResponse,
} from "node:http";
import { type AddressInfo, connect, type Socket } from "node:net";
import { pipeline } from "node:stream";
import { isServiceProxyOrigin, type MiseTarget, serviceProxyAddress, serviceProxyTarget } from "@trackwall/protocol";
import { DomainError, messageOf } from "../infra/errors.ts";

/**
 * The service proxy (§5.6, ADR-189): a listener on `127.0.0.1`, apart from the API, that passes a browser's request to
 * the running service the name in `Host` stands for (`<repo>.localhost:<port>`, `<task>.<repo>.localhost:<port>`),
 * WebSockets included. In a dev container one forwarded port then opens every service on the user's computer.
 *
 * It guarantees: a request reaches only the port of a service Trackwall runs and found answering (`services.address`),
 * never the daemon's API or the proxy itself, even when a service's log names one of their ports; a `Host` that is not a
 * name under `localhost` on this port is refused, so a page that rebinds its own domain to 127.0.0.1 reaches nothing; a
 * request a page of another site makes (its `Origin`, or `Sec-Fetch-Site` for an image, a script or a frame) is refused
 * unless it opens the service as the page itself, as a link does. No token: the browser opens the address directly, as
 * it would a forwarded port of the service.
 */

export interface ServiceProxyOptions {
  /** `0` picks a free port (tests). */
  port: number;
  /** The daemon's API port, which no service may stand for. */
  apiPort: number;
  /** Where the running service of `target` answers; a `DomainError` says why there is none. */
  address: (target: MiseTarget) => Promise<{ host: string; port: number }>;
  log: (msg: string) => void;
}

export interface ServiceProxy {
  port: number;
  close: () => Promise<void>;
}

/** Headers of one connection, not of the request (RFC 9110 §7.6.1); the proxy's own connections set their own. */
const HOP_BY_HOP = ["connection", "keep-alive", "proxy-connection", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];

/** What a refusal says when nothing names a service: how the addresses look. */
function addressHelp(port: number): string {
  const example = serviceProxyAddress(port, { repo: "<repo>", task: null });
  return `Trackwall opens a running service at ${example}, with the repo's name in place of <repo>.`;
}

/**
 * The proxy on `o.port`, or `null` with a line in the log when the port cannot be opened (another program holds it): the
 * daemon runs on without it.
 */
export async function openServiceProxy(o: ServiceProxyOptions): Promise<ServiceProxy | null> {
  try {
    return await startServiceProxy(o);
  } catch (err) {
    o.log(`no service proxy: port ${o.port} could not be opened (${(err as NodeJS.ErrnoException).code ?? messageOf(err)})`);
    return null;
  }
}

async function startServiceProxy(o: ServiceProxyOptions): Promise<ServiceProxy> {
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
    // Node takes its own error listener off the socket before `upgrade`: without one, a browser that goes away would end the daemon.
    socket.on("error", () => socket.destroy());
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

type Reached = { address: { host: string; port: number } } | { status: number; text: string };

/** The service a request may reach, or the status and sentence that refuse it. */
async function reach(req: IncomingMessage, port: number, o: ServiceProxyOptions): Promise<Reached> {
  const target = serviceProxyTarget(req.headers.host, port);
  if (!target) return { status: 404, text: addressHelp(port) };
  if (fromAnotherSite(req, port)) return { status: 403, text: "Trackwall passes no request from a page of another site to a service." };
  let address: { host: string; port: number };
  try {
    address = await o.address(target);
  } catch (err) {
    if (err instanceof DomainError)
      return { status: 502, text: `Trackwall cannot open this service: ${err.message}. Start it in Trackwall, then reload.` };
    throw err;
  }
  if (address.port === port || address.port === o.apiPort)
    return {
      status: 502,
      text: `The service's log names port ${address.port}, which is Trackwall's own, so Trackwall does not pass requests to it.`,
    };
  return { address };
}

/**
 * A request made by a page of another site: its `Origin` is not a page behind the proxy, or, for a request a browser
 * sends without `Origin` (an image, a script, a frame), `Sec-Fetch-Site` says another site made it, it does not open the
 * service as a page, and its `Referer` is not a page behind the proxy either. Each name under `localhost` is a site of
 * its own to the browser, so a page of one repo's service loading another's script counts as cross-site and is let
 * through by its `Referer`. A link from another site, Trackwall's Open among them, still opens the service.
 */
function fromAnotherSite(req: IncomingMessage, port: number): boolean {
  const origin = req.headers.origin;
  if (origin !== undefined) return !isServiceProxyOrigin(origin, port);
  const opensPage = req.headers["sec-fetch-mode"] === "navigate" && req.headers["sec-fetch-dest"] === "document";
  if (req.headers["sec-fetch-site"] !== "cross-site" || opensPage) return false;
  return !isServiceProxyOrigin(refererOrigin(req.headers.referer), port);
}

function refererOrigin(referer: string | undefined): string {
  if (!referer || !URL.canParse(referer)) return "";
  return new URL(referer).origin;
}

async function forward(req: IncomingMessage, res: ServerResponse, port: number, o: ServiceProxyOptions): Promise<void> {
  const reached = await reach(req, port, o);
  // The browser went away while the service was looked up: nothing to ask it.
  if (res.destroyed) return;
  if ("status" in reached) return answer(res, reached.status, reached.text);
  const { address } = reached;
  const upstream = request(
    { host: address.host, port: address.port, method: req.method, path: req.url, headers: forwardedHeaders(req) },
    (up) => {
      try {
        res.writeHead(up.statusCode ?? 502, up.statusMessage, responseHeaders(up.headers, address.port, req.headers.host));
      } catch (err) {
        // A header Node will not send: the service's answer goes no further, and the daemon stays up.
        o.log(`service proxy: the answer of the service on port ${address.port}: ${messageOf(err)}`);
        up.destroy();
        return answer(res, 502, "The service answered with a header Trackwall cannot pass on.");
      }
      // A service that dies halfway ends the browser's answer too, rather than leaving it open.
      pipeline(up, res, () => {});
    },
  );
  upstream.on("error", (err) => {
    // The browser went away first and the request to the service was stopped for it: not the service's failure.
    if (res.destroyed) return;
    o.log(`service proxy: the service on port ${address.port}: ${err.message}`);
    if (!res.headersSent) answer(res, 502, "The service closed the connection. Look at its log in Trackwall.");
    else res.destroy();
  });
  // A browser that goes away before the answer starts stops the request to the service too (after that, `pipeline` does).
  res.once("close", () => {
    if (!res.headersSent) upstream.destroy();
  });
  // An upload the browser gives up halfway is not left half sent to the service.
  req.once("error", () => upstream.destroy());
  req.once("aborted", () => upstream.destroy());
  req.pipe(upstream);
}

async function upgrade(req: IncomingMessage, socket: Socket, head: Buffer, port: number, o: ServiceProxyOptions): Promise<void> {
  const reached = await reach(req, port, o);
  if ("status" in reached) {
    socket.end(`HTTP/1.1 ${reached.status} ${reached.status === 404 ? "Not Found" : "Refused"}\r\nconnection: close\r\n\r\n`);
    return;
  }
  // The browser went away while the service was looked up: no connection to the service is opened for it.
  if (socket.destroyed) return;
  const upstream = connect({ host: reached.address.host, port: reached.address.port });
  upstream.on("error", () => socket.destroy());
  socket.once("close", () => upstream.destroy());
  upstream.once("close", () => socket.destroy());
  upstream.once("connect", () => {
    upstream.write(upgradeHead(req));
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
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

/** Without the hop-by-hop headers and those `Connection` names, though never `Host`, which picks the service's site. */
function withoutHopByHop(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const named = String(headers.connection ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== "" && h !== "host");
  const drop = new Set([...HOP_BY_HOP, ...named]);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !drop.has(name)));
}

function answer(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(`${text}\n`);
}
