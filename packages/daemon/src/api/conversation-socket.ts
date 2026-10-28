import {
  CONVERSATION_SOCKET_PREFIX,
  CONVERSATION_SUBPROTOCOL,
  ConversationClientMessage,
  PTY_CLOSE_NOT_FOUND,
  PTY_CLOSE_SLOW,
  SessionId,
} from "@trackwall/protocol";
import type { RawData, WebSocket } from "ws";
import type { Facade } from "../facade.ts";
import { DomainError } from "../infra/errors.ts";
import { parseJsonFrame } from "./socket-json.ts";
import type { SocketRoute } from "./sockets.ts";

/**
 * A session's conversation view over the WebSocket `/ws/conversation/<session>` (§5.2, ADR-107); `sockets.ts` checks
 * `Host`, `Origin` and the token. The daemon sends the entries as JSON frames, all of them first; the client sends only
 * whether the view is in front of the user (ADR-47). What the user writes goes through the `agents` API, not here.
 * The close codes are the terminal's.
 */

/** The client sends only `focus`. */
const MAX_FRAME_BYTES = 1024;
/** A view that does not receive entries (a frozen tab) cannot keep a whole conversation in the daemon's memory. */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

const CLOSE_INTERNAL = 1011;

export function conversationSocketRoute(facade: Facade): SocketRoute {
  return {
    subprotocol: CONVERSATION_SUBPROTOCOL,
    maxPayload: MAX_FRAME_BYTES,
    serve: (ws, path) => {
      const session = SessionId.safeParse(path.slice(CONVERSATION_SOCKET_PREFIX.length));
      if (session.success) serve(ws, session.data, facade);
      else ws.close(PTY_CLOSE_NOT_FOUND, "no such session");
    },
  };
}

function serve(ws: WebSocket, session: string, facade: Facade): void {
  let window: ReturnType<Facade["agents"]["attachConversation"]>;
  try {
    window = facade.agents.attachConversation(session, {
      send: (message) => {
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) ws.close(PTY_CLOSE_SLOW, "the view cannot keep up with the conversation");
        else ws.send(JSON.stringify(message));
      },
      closed: () => ws.close(PTY_CLOSE_NOT_FOUND, "session closed"),
    });
  } catch (err) {
    // An exception while handling `upgrade` would end the daemon, so any error ends only this connection.
    const notFound = err instanceof DomainError && err.code === "not_found";
    ws.close(notFound ? PTY_CLOSE_NOT_FOUND : CLOSE_INTERNAL, notFound ? "no such session" : "daemon error");
    return;
  }
  ws.on("message", (data: RawData, isBinary: boolean) => {
    if (isBinary) return;
    const parsed = ConversationClientMessage.safeParse(parseJsonFrame(data));
    if (parsed.success) window.focus(parsed.data.focused);
  });
  ws.on("close", () => window.detach());
  ws.on("error", () => window.detach());
}
