import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { daemonSocketAt, SOCKET_TOKEN_PREFIX } from "@trackwall/protocol";
import { type WebSocket, WebSocketServer } from "ws";
import { type OriginPolicy, tokenMatches } from "./guard.ts";

/**
 * WebSockety API (§5.2): zdarzenia `/ws` i terminale sesji `/ws/pty/<sesja>`. Jedno miejsce na obsługę `upgrade`
 * i te same zabezpieczenia co reszta API (§8): `Host` i `Origin` z `OriginPolicy`, token porównywany w stałym czasie.
 * Przeglądarka nie ustawi nagłówka przy WebSocket, więc token przychodzi jako podprotokół `bearer.<token>` obok
 * podprotokołu gniazda, a serwer potwierdza tylko ten drugi.
 */

/** Obsługa jednego gniazda z `DaemonSocket` (protocol), wybieranego po podprotokole adresu (`daemonSocketAt`). */
export interface SocketRoute {
  subprotocol: string;
  /** Największa ramka od klienta. */
  maxPayload: number;
  /** Połączenie pod adresem `path`, już po sprawdzeniu `Host`, `Origin` i tokenu. */
  serve(ws: WebSocket, path: string): void;
}

export interface SocketOptions {
  token: string;
  /** Polityka `Host`/`Origin` serwera API; `undefined`, dopóki port nie jest znany. */
  policy: () => OriginPolicy | undefined;
  routes: readonly SocketRoute[];
}

interface MountedRoute {
  route: SocketRoute;
  wss: WebSocketServer;
}

/** Podpina obsługę `upgrade` do serwera API; zwraca zamknięcie wszystkich połączeń. */
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
    // Node zdejmuje swój słuchacz `error` z gniazda przed `upgrade`: zerwane połączenie bez słuchacza (np. po odmowie)
    // zakończyłoby daemon. Tak samo każdy wyjątek tutaj, więc kończy on tylko to połączenie.
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
 * Gniazdo i adres połączenia albo status HTTP odmowy. Token przed adresem, żeby klient bez tokenu nie poznał po
 * odpowiedzi, które adresy istnieją.
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
  // Adres w formie bezwzględnej może się nie dać sparsować; `URL.parse` zwraca wtedy `null` zamiast rzucać.
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
  // Jak `abortHandshake` w `ws`: zamknięcie dopiero po wysłaniu odpowiedzi, żeby status nie przepadł w buforze.
  socket.once("finish", () => socket.destroy());
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
