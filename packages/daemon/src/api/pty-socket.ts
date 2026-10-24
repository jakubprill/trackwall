import { PTY_CLOSE_NOT_FOUND, PTY_CLOSE_SLOW, PTY_SOCKET_PREFIX, PTY_SUBPROTOCOL, PtyClientMessage, SessionId } from "@trackwall/protocol";
import type { RawData, WebSocket } from "ws";
import type { Facade } from "../facade.ts";
import { DomainError } from "../infra/errors.ts";
import type { SocketRoute } from "./sockets.ts";

/**
 * Terminal sesji przez WebSocket `/ws/pty/<sesja>` (§5.2, ADR-26); `Host`, `Origin` i token sprawdza `sockets.ts`.
 * Daemon wysyła obraz ekranu (ramka tekstowa), potem wyjście (ramki binarne); klient wysyła wejście i rozmiar.
 */

/** Wejście z klawiatury i wklejony tekst; większa ramka to nie człowiek przy klawiaturze. */
const MAX_FRAME_BYTES = 128 * 1024;
/** Okno, które nie odbiera wyjścia (zawieszona karta), nie może trzymać w pamięci daemona całej sesji. */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

const PTY_CLOSE_INTERNAL = 1011;

export function ptySocketRoute(facade: Facade): SocketRoute {
  return {
    subprotocol: PTY_SUBPROTOCOL,
    maxPayload: MAX_FRAME_BYTES,
    serve: (ws, path) => {
      const session = SessionId.safeParse(path.slice(PTY_SOCKET_PREFIX.length));
      if (session.success) serve(ws, session.data, facade);
      else ws.close(PTY_CLOSE_NOT_FOUND, "no such session");
    },
  };
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
