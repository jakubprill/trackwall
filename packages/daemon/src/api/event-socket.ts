import { EVENTS_CLOSE_SLOW, EVENTS_SOCKET } from "@trackwall/protocol";
import type { WebSocket } from "ws";
import type { EventHub } from "./event-hub.ts";
import type { SocketRoute } from "./sockets.ts";

/**
 * Zdarzenia daemona przez WebSocket `/ws` (§5.2, ADR-36); `Host`, `Origin` i token sprawdza `sockets.ts`. Daemon
 * wysyła ramki tekstowe JSON `DaemonEvent`, najpierw migawkę każdego tematu, potem zmiany. Klient nic nie wysyła.
 */

/** Klient nie ma czego wysyłać; większa ramka kończy połączenie. */
const MAX_FRAME_BYTES = 1024;
/** Klient, który nie odbiera (zawieszona karta), nie może trzymać w pamięci daemona kolejnych migawek. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export function eventSocketRoute(hub: EventHub): SocketRoute {
  return {
    subprotocol: EVENTS_SOCKET.subprotocol,
    maxPayload: MAX_FRAME_BYTES,
    serve: (ws) => serve(ws, hub),
  };
}

/** Temat przestał się dać odczytać: klient łączy się ponownie, dostaje migawki bez niego i pyta o niego HTTP. */
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
