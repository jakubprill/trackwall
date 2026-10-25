import { readFileSync } from "node:fs";
import { type IncomingMessage, request } from "node:http";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { DAEMON_FILE, DaemonFile, daemonSocketAt, SOCKET_TOKEN_PREFIX, TRACKWALL_HOME_ENV } from "@trackwall/protocol";
import type { Plugin } from "vite";

/**
 * Only `vite dev`: forwards `/api/*` and the WebSockets of events (`/ws`) and session terminals (`/ws/pty/*`) to the
 * daemon from `pnpm dev`, with the token from `daemon.json`.
 * The development daemon keeps its state in `<repo>/.trackwall-dev`, separate from the released app in `~/.trackwall`
 * (`TRACKWALL_HOME` overrides both).
 * The file is read on every request, so the start order of the daemon and Vite does not matter,
 * and the browser never sees the token.
 *
 * The proxy adds the token, so it has to guard what the daemon checks by `Origin` itself (§5.2): it lets through only
 * requests from the Vite page. Without this any page in the browser could send a POST form to
 * `127.0.0.1:5173/api/...` and perform an action in the daemon.
 */
/** The daemon's `dev` script gives the same directory (`--home ../../.trackwall-dev`). */
const DEV_HOME = fileURLToPath(new URL("../../.trackwall-dev", import.meta.url));

export function daemonDevProxy(): Plugin {
  return {
    name: "trackwall-daemon-dev-proxy",
    apply: "serve",
    configureServer(server) {
      const file = join(process.env[TRACKWALL_HOME_ENV] || DEV_HOME, DAEMON_FILE);
      const readDaemon = (): DaemonFile | undefined => {
        try {
          return DaemonFile.parse(JSON.parse(readFileSync(file, "utf8")));
        } catch {
          return undefined;
        }
      };
      const ownOrigins = () => [`http://127.0.0.1:${server.config.server.port}`, `http://localhost:${server.config.server.port}`];
      server.httpServer?.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        const target = daemonSocketAt(URL.parse(req.url ?? "/", "http://127.0.0.1")?.pathname ?? "");
        if (!target) return; // Vite HMR has its own handling
        const daemon = readDaemon();
        if (!daemon || (req.headers.origin !== undefined && !ownOrigins().includes(req.headers.origin))) return void socket.destroy();
        proxyDaemonSocket(req, socket, head, daemon, target.subprotocol);
      });
      server.middlewares.use("/api", (req, res) => {
        const reply = (status: number, message: string) => {
          if (res.headersSent) {
            res.destroy();
            return;
          }
          res.statusCode = status;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: false, error: { code: status === 403 ? "forbidden_origin" : "internal", message } }));
        };

        const own = ownOrigins();
        const origin = req.headers.origin;
        const site = req.headers["sec-fetch-site"];
        if ((origin !== undefined && !own.includes(origin)) || (site !== undefined && site !== "same-origin" && site !== "none")) {
          return reply(403, "request from outside the Vite page");
        }

        const daemon = readDaemon();
        if (!daemon) return reply(503, `daemon is not running (${file} missing or damaged)`);

        // node:http, not fetch: no detour through HTTP_PROXY, and the body streams both ways.
        const upstream = request(
          {
            host: "127.0.0.1",
            port: daemon.port,
            path: `/api${req.url ?? ""}`,
            method: req.method,
            agent: false,
            headers: {
              authorization: `Bearer ${daemon.token}`,
              "content-type": req.headers["content-type"] ?? "application/json",
              ...(req.headers["content-length"] ? { "content-length": req.headers["content-length"] } : {}),
            },
          },
          (up) => {
            res.statusCode = up.statusCode ?? 502;
            res.setHeader("content-type", up.headers["content-type"] ?? "application/json");
            // A connection dropped halfway through the response: the browser should get an error, not a hanging request.
            up.on("aborted", () => res.destroy());
            up.on("error", () => res.destroy());
            up.pipe(res);
          },
        );
        upstream.on("error", (err) => reply(502, `daemon is not responding: ${err.message}`));
        req.pipe(upstream);
      });
    },
  };
}

/**
 * The daemon's WebSocket: the proxy swaps the subprotocols for the socket's subprotocol with the token and drops the Vite
 * page's `Origin` (checked above), and after the protocol switch it passes frames both ways unchanged.
 */
function proxyDaemonSocket(req: IncomingMessage, socket: Duplex, head: Buffer, daemon: DaemonFile, subprotocol: string): void {
  const { origin: _, host: __, "sec-websocket-protocol": ___, ...headers } = req.headers;
  const upstream = request({
    host: "127.0.0.1",
    port: daemon.port,
    path: req.url,
    agent: false,
    headers: {
      ...headers,
      host: `127.0.0.1:${daemon.port}`,
      "sec-websocket-protocol": `${subprotocol}, ${SOCKET_TOKEN_PREFIX}${daemon.token}`,
    },
  });
  upstream.on("upgrade", (res, upSocket, upHead) => {
    const lines = Object.entries(res.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : [`${k}: ${v}`]));
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join("\r\n")}\r\n\r\n`);
    if (upHead.length > 0) socket.write(upHead);
    if (head.length > 0) upSocket.write(head);
    upSocket.pipe(socket).pipe(upSocket);
    upSocket.on("error", () => socket.destroy());
    socket.on("error", () => upSocket.destroy());
  });
  upstream.on("response", () => socket.destroy());
  upstream.on("error", () => socket.destroy());
  upstream.end();
}
