import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { SOCKET_TOKEN_PREFIX } from "@trackwall/protocol";
import { type WebSocket, WebSocketServer } from "ws";
import { type OriginPolicy, tokenMatches } from "./guard.ts";

/**
 * WebSockety API (§5.2): zdarzenia `/ws` i terminale sesji `/ws/pty/<sesja>`. Jedno miejsce na obsługę `upgrade`
 * i te same zabezpieczenia co reszta API (§8): `Host` i `Origin` z `OriginPolicy`, token porównywany w stałym czasie.
 * Przeglądarka nie ustawi nagłówka przy WebSocket, więc token przychodzi jako podprotokół `bearer.<token>` obok
 * podprotokołu gniazda, a serwer potwierdza tylko ten drugi.
 */

/** Jeden rodzaj gniazda: podprotokół, adresy, które obsługuje, i obsługa połączenia. */
export interface SocketRoute {
  subprotocol: string;
  /** Największa ramka od klienta. */
  maxPayload: number;
  /**
   * Obsługa połączenia pod tym adresem, `"not_found"` dla adresu tego gniazda bez celu (np. zły identyfikator sesji)
   * albo `undefined`, gdy adres należy do innego gniazda.
   */
  route(path: string): ((ws: WebSocket) => void) | "not_found" | undefined;
}

export interface SocketOptions {
  token: string;
  /** Polityka `Host`/`Origin` serwera API; `undefined`, dopóki port nie jest znany. */
  policy: () => OriginPolicy | undefined;
  routes: readonly SocketRoute[];
}

/** Podpina obsługę `upgrade` do serwera API; zwraca zamknięcie wszystkich połączeń. */
export function attachSockets(server: Server, o: SocketOptions): () => void {
  const servers = o.routes.map((route) => ({
    route,
    wss: new WebSocketServer({
      noServer: true,
      maxPayload: route.maxPayload,
      handleProtocols: (protocols) => (protocols.has(route.subprotocol) ? route.subprotocol : false),
    }),
  }));
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Node zdejmuje swój słuchacz `error` z gniazda przed `upgrade`: zerwane połączenie bez słuchacza (np. po odmowie)
    // zakończyłoby daemon. Tak samo każdy wyjątek tutaj, więc kończy on tylko to połączenie.
    socket.on("error", () => socket.destroy());
    try {
      const admitted = admit(req, o, servers);
      if ("refused" in admitted) return reject(socket, admitted.refused);
      admitted.wss.handleUpgrade(req, socket, head, admitted.serve);
    } catch {
      reject(socket, "500 Internal Server Error");
    }
  });
  return () => {
    for (const { wss } of servers) {
      for (const client of wss.clients) client.terminate();
      wss.close();
    }
  };
}

type Admitted = { wss: WebSocketServer; serve: (ws: WebSocket) => void } | { refused: string };

/** Gniazdo i obsługa połączenia albo status HTTP odmowy. */
function admit(req: IncomingMessage, o: SocketOptions, servers: readonly { route: SocketRoute; wss: WebSocketServer }[]): Admitted {
  const policy = o.policy();
  if (!policy?.isAllowedHost(req.headers.host) || !policy.isAllowedOrigin(req.headers.origin)) return { refused: "403 Forbidden" };
  // Adres w formie bezwzględnej może się nie dać sparsować; `URL.parse` zwraca wtedy `null` zamiast rzucać.
  const path = URL.parse(req.url ?? "/", "http://127.0.0.1")?.pathname ?? "";
  for (const { route, wss } of servers) {
    const serve = route.route(path);
    if (serve === undefined) continue;
    if (serve === "not_found") return { refused: "404 Not Found" };
    const protocols = (req.headers["sec-websocket-protocol"] ?? "").split(",").map((p) => p.trim());
    const given = protocols.find((p) => p.startsWith(SOCKET_TOKEN_PREFIX))?.slice(SOCKET_TOKEN_PREFIX.length);
    if (!protocols.includes(route.subprotocol) || given === undefined || !tokenMatches(given, o.token))
      return { refused: "401 Unauthorized" };
    return { wss, serve };
  }
  return { refused: "404 Not Found" };
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
