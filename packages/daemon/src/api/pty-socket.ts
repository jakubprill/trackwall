import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import {
  PTY_CLOSE_NOT_FOUND,
  PTY_CLOSE_SLOW,
  PTY_SOCKET_PREFIX,
  PTY_SUBPROTOCOL,
  PTY_TOKEN_PREFIX,
  PtyClientMessage,
  SessionId,
} from "@trackwall/protocol";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { DomainError } from "../errors.ts";
import type { Facade } from "../facade.ts";
import { type OriginPolicy, tokenMatches } from "./guard.ts";

/**
 * Terminal sesji przez WebSocket `/ws/pty/<sesja>` (§5.2, ADR-26). Te same zabezpieczenia co reszta API (§8):
 * `Host` i `Origin` z `OriginPolicy`, token porównywany w stałym czasie. Przeglądarka nie ustawi nagłówka przy
 * WebSocket, więc token przychodzi jako podprotokół `bearer.<token>`, a serwer odpowiada tylko `trackwall.pty`.
 * Daemon wysyła obraz ekranu (ramka tekstowa), potem wyjście (ramki binarne); klient wysyła wejście i rozmiar.
 */

/** Wejście z klawiatury i wklejony tekst; większa ramka to nie człowiek przy klawiaturze. */
const MAX_FRAME_BYTES = 128 * 1024;
/** Okno, które nie odbiera wyjścia (zawieszona karta), nie może trzymać w pamięci daemona całej sesji. */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

const PTY_CLOSE_INTERNAL = 1011;

export interface PtySocketOptions {
  token: string;
  facade: Facade;
  /** Polityka `Host`/`Origin` serwera API; `undefined`, dopóki port nie jest znany. */
  policy: () => OriginPolicy | undefined;
}

/** Podpina obsługę `upgrade` do serwera API; zwraca zamknięcie wszystkich połączeń terminali. */
export function attachPtySockets(server: Server, o: PtySocketOptions): () => void {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    handleProtocols: (protocols) => (protocols.has(PTY_SUBPROTOCOL) ? PTY_SUBPROTOCOL : false),
  });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Node zdejmuje swój słuchacz `error` z gniazda przed `upgrade`: zerwane połączenie bez słuchacza (np. po odmowie)
    // zakończyłoby daemon. Tak samo każdy wyjątek tutaj, więc kończy on tylko to połączenie.
    socket.on("error", () => socket.destroy());
    try {
      const admitted = admit(req, o);
      if ("refused" in admitted) return reject(socket, admitted.refused);
      wss.handleUpgrade(req, socket, head, (ws) => serve(ws, admitted.session, o.facade));
    } catch {
      reject(socket, "500 Internal Server Error");
    }
  });
  return () => {
    for (const client of wss.clients) client.terminate();
    wss.close();
  };
}

/** Sesja, do której prowadzi połączenie, albo status HTTP odmowy. */
function admit(req: IncomingMessage, o: PtySocketOptions): { session: string } | { refused: string } {
  const policy = o.policy();
  if (!policy?.isAllowedHost(req.headers.host) || !policy.isAllowedOrigin(req.headers.origin)) return { refused: "403 Forbidden" };
  // Adres w formie bezwzględnej może się nie dać sparsować; `URL.parse` zwraca wtedy `null` zamiast rzucać.
  const path = URL.parse(req.url ?? "/", "http://127.0.0.1")?.pathname ?? "";
  const session = path.startsWith(PTY_SOCKET_PREFIX) ? SessionId.safeParse(path.slice(PTY_SOCKET_PREFIX.length)) : undefined;
  if (!session?.success) return { refused: "404 Not Found" };
  const protocols = (req.headers["sec-websocket-protocol"] ?? "").split(",").map((p) => p.trim());
  const given = protocols.find((p) => p.startsWith(PTY_TOKEN_PREFIX))?.slice(PTY_TOKEN_PREFIX.length);
  if (!protocols.includes(PTY_SUBPROTOCOL) || given === undefined || !tokenMatches(given, o.token)) return { refused: "401 Unauthorized" };
  return { session: session.data };
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

function serve(ws: WebSocket, session: string, facade: Facade): void {
  let attachment: ReturnType<Facade["agents"]["attach"]>;
  try {
    attachment = facade.agents.attach(
      session,
      (bytes) => {
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) ws.close(PTY_CLOSE_SLOW, "the window cannot keep up with the output");
        else ws.send(bytes, { binary: true });
      },
      (snapshot) => ws.send(snapshot),
      () => ws.close(PTY_CLOSE_NOT_FOUND, "session closed"),
    );
  } catch (err) {
    // Wyjątek w obsłudze `upgrade` zakończyłby daemon, więc każdy błąd kończy tylko to połączenie.
    const notFound = err instanceof DomainError && err.code === "not_found";
    ws.close(notFound ? PTY_CLOSE_NOT_FOUND : PTY_CLOSE_INTERNAL, notFound ? "no such session" : "daemon error");
    return;
  }
  ws.on("message", (data: RawData, isBinary: boolean) => {
    if (isBinary) return;
    const message = PtyClientMessage.safeParse(parseJson(data));
    if (!message.success) return;
    if (message.data.type === "input") attachment.input(message.data.data);
    else attachment.resize(message.data.cols, message.data.rows);
  });
  ws.on("close", () => attachment.detach());
  ws.on("error", () => attachment.detach());
}

/** Ramka tekstowa od klienta; `ws` podaje ją jako `Buffer`, w kawałkach albo jako `ArrayBuffer`. */
function parseJson(data: RawData): unknown {
  const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(new Uint8Array(data));
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
}
