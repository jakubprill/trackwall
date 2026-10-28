import { PTY_CLOSE_NOT_FOUND, PTY_CLOSE_SLOW, PTY_SOCKET_PREFIX, PTY_SUBPROTOCOL, PtyClientMessage, SessionId } from "@trackwall/protocol";
import type { RawData, WebSocket } from "ws";
import type { Facade } from "../facade.ts";
import { DomainError } from "../infra/errors.ts";
import { parseJsonFrame } from "./socket-json.ts";
import type { SocketRoute } from "./sockets.ts";

/**
 * Session terminal over the WebSocket `/ws/pty/<session>` (§5.2, ADR-26); `sockets.ts` checks `Host`, `Origin` and the
 * token. The daemon sends the screen image (a text frame), then the output (binary frames); the client sends input,
 * size and whether the window is in front of the user (ADR-47).
 */

/** Keyboard input and pasted text; a larger frame is not a human at a keyboard. */
const MAX_FRAME_BYTES = 128 * 1024;
/** A window that does not receive output (a frozen tab) cannot keep a whole session in the daemon's memory. */
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
    // An exception while handling `upgrade` would end the daemon, so any error ends only this connection.
    const notFound = err instanceof DomainError && err.code === "not_found";
    ws.close(notFound ? PTY_CLOSE_NOT_FOUND : PTY_CLOSE_INTERNAL, notFound ? "no such session" : "daemon error");
    return;
  }
  ws.on("message", (data: RawData, isBinary: boolean) => {
    if (isBinary) return;
    const parsed = PtyClientMessage.safeParse(parseJsonFrame(data));
    if (!parsed.success) return;
    const message = parsed.data;
    switch (message.type) {
      case "input":
        return attachment.input(message.data);
      case "resize":
        return attachment.resize(message.cols, message.rows);
      case "focus":
        return attachment.focus(message.focused);
    }
  });
  ws.on("close", () => attachment.detach());
  ws.on("error", () => attachment.detach());
}
