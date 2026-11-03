import {
  PTY_CLOSE_NOT_FOUND,
  PTY_CLOSE_SLOW,
  PTY_SOCKET_PREFIX,
  PTY_SUBPROTOCOL,
  PtyClientMessage,
  SessionId,
  TERMINAL_SOCKET_PREFIX,
  TERMINAL_SUBPROTOCOL,
  TerminalId,
} from "@trackwall/protocol";
import type { RawData, WebSocket } from "ws";
import type { z } from "zod";
import type { Facade } from "../facade.ts";
import { DomainError } from "../infra/errors.ts";
import { parseJsonFrame } from "./socket-json.ts";
import type { SocketRoute } from "./sockets.ts";

/**
 * A terminal over a WebSocket (§5.2): a session's at `/ws/pty/<session>` (ADR-26), a folder terminal's at
 * `/ws/terminal/<terminal>` (ADR-185); `sockets.ts` checks `Host`, `Origin` and the token. The daemon sends the screen
 * image (a text frame), then the output (binary frames); the client sends input, size and whether the window is in
 * front of the user (ADR-47), which only a session uses.
 */

/** Keyboard input and pasted text; a larger frame is not a human at a keyboard. */
const MAX_FRAME_BYTES = 128 * 1024;
/** A window that does not receive output (a frozen tab) cannot keep a whole session in the daemon's memory. */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

const PTY_CLOSE_INTERNAL = 1011;

/** One window of a terminal, as `agents` and `terminals` give it. */
interface PtyWindow {
  input(data: string): void;
  resize(cols: number, rows: number): void;
  focus?(focused: boolean): void;
  detach(): void;
}

type Attach = (id: string, output: (bytes: Uint8Array) => void, onSnapshot: (snapshot: string) => void, onClosed: () => void) => PtyWindow;

interface PtyKind {
  prefix: string;
  subprotocol: string;
  id: z.ZodType<string>;
  /** What the client calls the terminal in a close reason. */
  noun: string;
  attach: Attach;
}

export function sessionSocketRoute(facade: Facade): SocketRoute {
  return route({
    prefix: PTY_SOCKET_PREFIX,
    subprotocol: PTY_SUBPROTOCOL,
    id: SessionId,
    noun: "session",
    attach: (id, output, onSnapshot, onClosed) => facade.agents.attach(id, output, onSnapshot, onClosed),
  });
}

export function terminalSocketRoute(facade: Facade): SocketRoute {
  return route({
    prefix: TERMINAL_SOCKET_PREFIX,
    subprotocol: TERMINAL_SUBPROTOCOL,
    id: TerminalId,
    noun: "terminal",
    attach: (id, output, onSnapshot, onClosed) => facade.terminals.attach(id, output, onSnapshot, onClosed),
  });
}

function route(kind: PtyKind): SocketRoute {
  return {
    subprotocol: kind.subprotocol,
    maxPayload: MAX_FRAME_BYTES,
    serve: (ws, path) => {
      const id = kind.id.safeParse(path.slice(kind.prefix.length));
      if (id.success) serve(ws, id.data, kind);
      else ws.close(PTY_CLOSE_NOT_FOUND, `no such ${kind.noun}`);
    },
  };
}

function serve(ws: WebSocket, id: string, kind: PtyKind): void {
  let window: PtyWindow;
  try {
    window = kind.attach(
      id,
      (bytes) => {
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) ws.close(PTY_CLOSE_SLOW, "the window cannot keep up with the output");
        else ws.send(bytes, { binary: true });
      },
      (snapshot) => ws.send(snapshot),
      () => ws.close(PTY_CLOSE_NOT_FOUND, `${kind.noun} closed`),
    );
  } catch (err) {
    // An exception while handling `upgrade` would end the daemon, so any error ends only this connection.
    const notFound = err instanceof DomainError && err.code === "not_found";
    ws.close(notFound ? PTY_CLOSE_NOT_FOUND : PTY_CLOSE_INTERNAL, notFound ? `no such ${kind.noun}` : "daemon error");
    return;
  }
  ws.on("message", (data: RawData, isBinary: boolean) => {
    if (isBinary) return;
    const parsed = PtyClientMessage.safeParse(parseJsonFrame(data));
    if (!parsed.success) return;
    const message = parsed.data;
    switch (message.type) {
      case "input":
        return window.input(message.data);
      case "resize":
        return window.resize(message.cols, message.rows);
      case "focus":
        return window.focus?.(message.focused);
    }
  });
  ws.on("close", () => window.detach());
  ws.on("error", () => window.detach());
}
