import { PTY_SOCKET_PREFIX, PTY_SUBPROTOCOL, PTY_TOKEN_PREFIX } from "@trackwall/protocol";
import type { Connection } from "./connection.ts";

/**
 * Adres i podprotokoły WebSocketu terminala sesji (§5.2). Token idzie jako podprotokół, bo przeglądarka nie ustawi
 * nagłówka przy WebSocket; w `vite dev` UI nie zna tokenu i dokłada go proxy Vite (`dev-proxy.ts`).
 */
export function ptySocket(
  conn: Connection,
  session: string,
  location: Pick<Location, "protocol" | "host">,
): { url: string; protocols: string[] } {
  const base = conn.baseUrl === "" ? `${location.protocol}//${location.host}` : conn.baseUrl;
  const url = `${base.replace(/^http/, "ws")}${PTY_SOCKET_PREFIX}${session}`;
  const protocols = conn.token ? [PTY_SUBPROTOCOL, `${PTY_TOKEN_PREFIX}${conn.token}`] : [PTY_SUBPROTOCOL];
  return { url, protocols };
}
