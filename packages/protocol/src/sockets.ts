/**
 * WebSockety daemona (§5.2): zdarzenia `/ws` (ADR-36) i terminale sesji `/ws/pty/<sesja>` (ADR-26). Adres i podprotokół
 * gniazda idą zawsze w parze (`DaemonSocket`), więc daemon, proxy Vite i UI nie mogą ich połączyć inaczej.
 */

/** Gniazdo daemona: adres i podprotokół, który klient podaje obok tokenu, a serwer potwierdza. */
export interface DaemonSocket {
  path: string;
  subprotocol: string;
}

/**
 * Token daemona w WebSocketach. Przeglądarka nie ustawi nagłówka `Authorization` przy WebSocket, więc token idzie
 * jako drugi podprotokół (`bearer.<token>`), a nie w adresie, który trafia do logów i historii.
 */
export const SOCKET_TOKEN_PREFIX = "bearer.";

export const EVENTS_SOCKET: DaemonSocket = { path: "/ws", subprotocol: "trackwall.events" };

/** Ścieżka WebSocketu terminala sesji: `/ws/pty/<sesja>`. */
export const PTY_SOCKET_PREFIX = "/ws/pty/";
export const PTY_SUBPROTOCOL = "trackwall.pty";

export function ptySocket(session: string): DaemonSocket {
  return { path: `${PTY_SOCKET_PREFIX}${session}`, subprotocol: PTY_SUBPROTOCOL };
}

/** Gniazdo daemona pod tym adresem (bez query); `undefined` dla adresu spoza daemona (np. HMR Vite). */
export function daemonSocketAt(path: string): DaemonSocket | undefined {
  if (path === EVENTS_SOCKET.path) return EVENTS_SOCKET;
  if (path.startsWith(PTY_SOCKET_PREFIX)) return ptySocket(path.slice(PTY_SOCKET_PREFIX.length));
  return undefined;
}
