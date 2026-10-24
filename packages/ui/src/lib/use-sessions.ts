import { agentsApi } from "@trackwall/protocol";
import { useMemo } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import type { DaemonEvents } from "./daemon-events.ts";
import { useRemote } from "./use-remote.ts";

/**
 * Lista sesji przychodzi na żywo z WebSocketu zdarzeń (ADR-36). Bez połączenia zdarzeń jest odpytywana, częściej,
 * gdy jest na ekranie (`open`: „Home” albo „Sessions” w oknie, zawsze w panelu przy trayu).
 */
const SESSIONS_POLL_MS = { open: 1000, closed: 3000 };

export function useSessions(conn: Connection | undefined, events: DaemonEvents | undefined, open: boolean) {
  const load = useMemo(() => conn && (() => post(conn, agentsApi.sessions, {})), [conn]);
  const live = useMemo(() => events?.feed("sessions.changed"), [events]);
  return useRemote(load, { pollMs: () => (open ? SESSIONS_POLL_MS.open : SESSIONS_POLL_MS.closed), live });
}
