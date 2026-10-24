import { SOCKET_TOKEN_PREFIX } from "@trackwall/protocol";
import type { Connection } from "./connection.ts";

/**
 * Adres i podprotokoły WebSocketu daemona (§5.2): zdarzeń `/ws` albo terminala sesji `/ws/pty/<sesja>`. Token idzie
 * jako podprotokół, bo przeglądarka nie ustawi nagłówka przy WebSocket; w `vite dev` UI nie zna tokenu i dokłada go
 * proxy Vite (`dev-proxy.ts`).
 */
export function daemonSocket(
  conn: Connection,
  path: string,
  subprotocol: string,
  location: Pick<Location, "protocol" | "host">,
): { url: string; protocols: string[] } {
  const base = conn.baseUrl === "" ? `${location.protocol}//${location.host}` : conn.baseUrl;
  const url = `${base.replace(/^http/, "ws")}${path}`;
  const protocols = conn.token ? [subprotocol, `${SOCKET_TOKEN_PREFIX}${conn.token}`] : [subprotocol];
  return { url, protocols };
}
