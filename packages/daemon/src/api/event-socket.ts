import { EVENTS_CLOSE_SLOW, EVENTS_SOCKET } from "@trackwall/protocol";
import type { WebSocket } from "ws";
import type { EventHub } from "./event-hub.ts";
import type { SocketRoute } from "./sockets.ts";

/**
 * Daemon events over the `/ws` WebSocket (§5.2, ADR-36); `sockets.ts` checks `Host`, `Origin` and the token. The daemon
 * sends `DaemonEvent` JSON text frames, first a snapshot of every topic, then the changes. The client sends nothing.
 */

/** The client has nothing to send; a larger frame ends the connection. */
const MAX_FRAME_BYTES = 1024;
/** A client that does not receive (a frozen tab) cannot keep further snapshots in the daemon's memory. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export function eventSocketRoute(hub: EventHub): SocketRoute {
  return {
    subprotocol: EVENTS_SOCKET.subprotocol,
    maxPayload: MAX_FRAME_BYTES,
    serve: (ws) => serve(ws, hub),
  };
}

/** A topic can no longer be read: the client reconnects, gets the snapshots without it and asks for it over HTTP. */
const EVENTS_CLOSE_TOPIC_FAILED = 1011;

function serve(ws: WebSocket, hub: EventHub): void {
  const unsubscribe = hub.subscribe({
    event: (frame) => {
      if (ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) ws.close(EVENTS_CLOSE_SLOW, "the client cannot keep up with the events");
      else ws.send(frame);
    },
    topicFailed: () => ws.close(EVENTS_CLOSE_TOPIC_FAILED, "the daemon cannot read an event topic"),
  });
  ws.on("close", unsubscribe);
  ws.on("error", unsubscribe);
}
