/**
 * The daemon's WebSockets (§5.2): events on `/ws` (ADR-36), session terminals on `/ws/pty/<session>` (ADR-26) and the
 * conversation view on `/ws/conversation/<session>` (ADR-107). A
 * socket's address and subprotocol always go together (`DaemonSocket`), so the daemon, the Vite proxy and the UI cannot
 * pair them differently.
 */

/** A daemon socket: the address and the subprotocol the client gives next to the token and the server confirms. */
export interface DaemonSocket {
  path: string;
  subprotocol: string;
}

/**
 * The daemon token in WebSockets. A browser does not set the `Authorization` header on a WebSocket, so the token goes as a
 * second subprotocol (`bearer.<token>`), not in the address, which ends up in logs and history.
 */
export const SOCKET_TOKEN_PREFIX = "bearer.";

export const EVENTS_SOCKET: DaemonSocket = { path: "/ws", subprotocol: "trackwall.events" };

/** The path of a session terminal's WebSocket: `/ws/pty/<session>`. */
export const PTY_SOCKET_PREFIX = "/ws/pty/";
export const PTY_SUBPROTOCOL = "trackwall.pty";

export function ptySocket(session: string): DaemonSocket {
  return { path: `${PTY_SOCKET_PREFIX}${session}`, subprotocol: PTY_SUBPROTOCOL };
}

/** The path of a session's conversation view (ADR-107): `/ws/conversation/<session>`. */
export const CONVERSATION_SOCKET_PREFIX = "/ws/conversation/";
export const CONVERSATION_SUBPROTOCOL = "trackwall.conversation";

export function conversationSocket(session: string): DaemonSocket {
  return { path: `${CONVERSATION_SOCKET_PREFIX}${session}`, subprotocol: CONVERSATION_SUBPROTOCOL };
}

/** The daemon socket at this address (without query); `undefined` for an address outside the daemon (for example Vite HMR). */
export function daemonSocketAt(path: string): DaemonSocket | undefined {
  if (path === EVENTS_SOCKET.path) return EVENTS_SOCKET;
  if (path.startsWith(PTY_SOCKET_PREFIX)) return ptySocket(path.slice(PTY_SOCKET_PREFIX.length));
  if (path.startsWith(CONVERSATION_SOCKET_PREFIX)) return conversationSocket(path.slice(CONVERSATION_SOCKET_PREFIX.length));
  return undefined;
}
