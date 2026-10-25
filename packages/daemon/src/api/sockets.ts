import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { daemonSocketAt, SOCKET_TOKEN_PREFIX } from "@trackwall/protocol";
import { type WebSocket, WebSocketServer } from "ws";
import { type OriginPolicy, tokenMatches } from "./guard.ts";

/**
 * The API's WebSockets (§5.2): `/ws` events and session terminals `/ws/pty/<session>`. One place to handle `upgrade`
 * and the same protections as the rest of the API (§8): `Host` and `Origin` from `OriginPolicy`, the token compared in constant time.
 * A browser cannot set a header for a WebSocket, so the token comes as the `bearer.<token>` subprotocol next to
 * the socket's subprotocol, and the server confirms only the latter.
 */

/** Handling of one socket from `DaemonSocket` (protocol), chosen by the address's subprotocol (`daemonSocketAt`). */
export interface SocketRoute {
  subprotocol: string;
  /** The largest frame from the client. */
  maxPayload: number;
  /** A connection at address `path`, after `Host`, `Origin` and the token have been checked. */
  serve(ws: WebSocket, path: string): void;
}

export interface SocketOptions {
  token: string;
  /** The API server's `Host`/`Origin` policy; `undefined` until the port is known. */
  policy: () => OriginPolicy | undefined;
  routes: readonly SocketRoute[];
}

interface MountedRoute {
  route: SocketRoute;
  wss: WebSocketServer;
}

/** Attaches `upgrade` handling to the API server; returns the closing of all connections. */
export function attachSockets(server: Server, o: SocketOptions): () => void {
  const mounted = new Map<string, MountedRoute>(
    o.routes.map((route) => [
      route.subprotocol,
      {
        route,
        wss: new WebSocketServer({
          noServer: true,
          maxPayload: route.maxPayload,
          handleProtocols: (protocols) => (protocols.has(route.subprotocol) ? route.subprotocol : false),
        }),
      },
    ]),
  );
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Node removes its `error` listener from the socket before `upgrade`: a broken connection without a listener (e.g. after a refusal)
    // would end the daemon. The same goes for any exception here, so it ends only this connection.
    socket.on("error", () => socket.destroy());
    try {
      const admitted = admit(req, o, mounted);
      if ("refused" in admitted) return reject(socket, admitted.refused);
      const { route, wss } = admitted.mounted;
      wss.handleUpgrade(req, socket, head, (ws) => route.serve(ws, admitted.path));
    } catch {
      reject(socket, "500 Internal Server Error");
    }
  });
  return () => {
    for (const { wss } of mounted.values()) {
      for (const client of wss.clients) client.terminate();
      wss.close();
    }
  };
}

/**
 * The connection's socket and address, or the HTTP status of the refusal. The token before the address, so that a client
 * without a token cannot tell from the response which addresses exist.
 */
function admit(
  req: IncomingMessage,
  o: SocketOptions,
  mounted: ReadonlyMap<string, MountedRoute>,
): { mounted: MountedRoute; path: string } | { refused: string } {
  const policy = o.policy();
  if (!policy?.isAllowedHost(req.headers.host) || !policy.isAllowedOrigin(req.headers.origin)) return { refused: "403 Forbidden" };
  const protocols = (req.headers["sec-websocket-protocol"] ?? "").split(",").map((p) => p.trim());
  const given = protocols.find((p) => p.startsWith(SOCKET_TOKEN_PREFIX))?.slice(SOCKET_TOKEN_PREFIX.length);
  if (given === undefined || !tokenMatches(given, o.token)) return { refused: "401 Unauthorized" };
  // An address in absolute form may fail to parse; `URL.parse` then returns `null` instead of throwing.
  const path = URL.parse(req.url ?? "/", "http://127.0.0.1")?.pathname ?? "";
  const target = daemonSocketAt(path);
  const route = target && mounted.get(target.subprotocol);
  if (!route) return { refused: "404 Not Found" };
  if (!protocols.includes(route.route.subprotocol)) return { refused: "400 Bad Request" };
  return { mounted: route, path };
}

function reject(socket: Duplex, status: string): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  // Like `abortHandshake` in `ws`: close only after the response is sent, so that the status is not lost in the buffer.
  socket.once("finish", () => socket.destroy());
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
