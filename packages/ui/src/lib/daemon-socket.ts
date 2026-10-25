import { type DaemonSocket, SOCKET_TOKEN_PREFIX } from "@trackwall/protocol";
import type { Connection } from "./connection.ts";

/**
 * The address and subprotocols of a daemon WebSocket (§5.2): events on `/ws` or a session terminal on `/ws/pty/<session>`.
 * The token goes as a subprotocol, because a browser does not set the header on a WebSocket; in `vite dev` the UI does
 * not know the token, and the Vite proxy (`dev-proxy.ts`) adds it.
 */
export function daemonSocket(
  conn: Connection,
  { path, subprotocol }: DaemonSocket,
  location: Pick<Location, "protocol" | "host">,
): { url: string; protocols: string[] } {
  const base = conn.baseUrl === "" ? `${location.protocol}//${location.host}` : conn.baseUrl;
  const url = `${base.replace(/^http/, "ws")}${path}`;
  const protocols = conn.token ? [subprotocol, `${SOCKET_TOKEN_PREFIX}${conn.token}`] : [subprotocol];
  return { url, protocols };
}
