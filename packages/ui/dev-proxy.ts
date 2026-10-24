import { readFileSync } from "node:fs";
import { type IncomingMessage, request } from "node:http";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  DAEMON_FILE,
  DaemonFile,
  EVENTS_SOCKET_PATH,
  EVENTS_SUBPROTOCOL,
  PTY_SOCKET_PREFIX,
  PTY_SUBPROTOCOL,
  SOCKET_TOKEN_PREFIX,
  TRACKWALL_HOME_ENV,
} from "@trackwall/protocol";
import type { Plugin } from "vite";

/**
 * Tylko `vite dev`: przekazuje `/api/*` i WebSockety zdarzeń (`/ws`) i terminala sesji (`/ws/pty/*`) do daemona z `pnpm dev` z tokenem
 * z `daemon.json`.
 * Daemon deweloperski trzyma stan w `<repo>/.trackwall-dev`, osobno od wydanej aplikacji w `~/.trackwall`
 * (`TRACKWALL_HOME` nadpisuje oba).
 * Plik jest czytany przy każdym żądaniu, więc kolejność startu daemona i Vite nie ma znaczenia,
 * a przeglądarka nigdy nie widzi tokenu.
 *
 * Proxy dokłada token, więc samo musi pilnować tego, co daemon sprawdza po `Origin` (§5.2): przepuszcza tylko
 * żądania ze strony Vite. Bez tego dowolna strona w przeglądarce mogłaby wysłać formularz POST na
 * `127.0.0.1:5173/api/...` i wykonać akcję w daemonie.
 */
/** Ten sam katalog podaje skrypt `dev` daemona (`--home ../../.trackwall-dev`). */
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
        const subprotocol = daemonSubprotocol(req.url);
        if (!subprotocol) return; // HMR Vite ma własną obsługę
        const daemon = readDaemon();
        if (!daemon || (req.headers.origin !== undefined && !ownOrigins().includes(req.headers.origin))) return void socket.destroy();
        proxyDaemonSocket(req, socket, head, daemon, subprotocol);
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
          return reply(403, "żądanie spoza strony Vite");
        }

        const daemon = readDaemon();
        if (!daemon) return reply(503, `daemon nie działa (brak albo uszkodzony ${file})`);

        // node:http, nie fetch: bez obejścia przez HTTP_PROXY i ze strumieniowaniem ciała w obie strony.
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
            // Zerwane połączenie w połowie odpowiedzi: przeglądarka ma dostać błąd, a nie wiszące żądanie.
            up.on("aborted", () => res.destroy());
            up.on("error", () => res.destroy());
            up.pipe(res);
          },
        );
        upstream.on("error", (err) => reply(502, `daemon nie odpowiada: ${err.message}`));
        req.pipe(upstream);
      });
    },
  };
}

/** Podprotokół WebSocketu daemona pod tym adresem; `undefined` dla adresów spoza daemona (HMR Vite). */
function daemonSubprotocol(url: string | undefined): string | undefined {
  const path = url?.split("?")[0];
  if (path === EVENTS_SOCKET_PATH) return EVENTS_SUBPROTOCOL;
  if (path?.startsWith(PTY_SOCKET_PREFIX)) return PTY_SUBPROTOCOL;
  return undefined;
}

/**
 * WebSocket daemona: proxy podmienia podprotokoły na podprotokół gniazda z tokenem i bez `Origin` strony Vite
 * (sprawdzonego wyżej), a po przełączeniu protokołu przepuszcza ramki w obie strony bez zmian.
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
