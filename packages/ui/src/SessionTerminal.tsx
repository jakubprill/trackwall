import "@xterm/xterm/css/xterm.css";
import type { PtyClientMessage } from "@trackwall/protocol";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import type { Connection } from "@/lib/connection";
import { ptySocket } from "@/lib/pty-socket";
import { terminalTheme } from "@/lib/terminal-theme";

/** Kod zamknięcia od daemona, gdy sesji nie ma (`PTY_CLOSE_NOT_FOUND` w daemonie). */
const CLOSE_NOT_FOUND = 4404;
const RECONNECT_MS = 1000;

/**
 * Okno terminala jednej sesji (§4.4, ADR-24): xterm.js podłączony WebSocketem do PTY w daemonie. Daemon najpierw
 * przysyła obraz ekranu, więc przełączenie sesji albo zerwane połączenie zaczyna od aktualnego ekranu, a nie od
 * pustego terminala. Klawisze i rozmiar okna idą do sesji; rozmiar PTY ustala ostatnie okno, które go zgłosiło.
 */
export function SessionTerminal({ conn, session, live }: { conn: Connection; session: string; live: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const terminal = new Terminal({
      theme: terminalTheme(document.documentElement),
      fontFamily: getComputedStyle(element).fontFamily,
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);
    fit.fit();
    terminal.focus();

    let socket: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const send = (message: PtyClientMessage) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };
    const sendSize = () => send({ type: "resize", cols: terminal.cols, rows: terminal.rows });

    const connect = () => {
      const { url, protocols } = ptySocket(conn, session, window.location);
      const ws = new WebSocket(url, protocols);
      ws.binaryType = "arraybuffer";
      socket = ws;
      ws.onopen = () => {
        setNotice(undefined);
        sendSize();
      };
      ws.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
        // Ramka tekstowa to obraz ekranu na start połączenia: zastępuje to, co okno pokazywało wcześniej.
        if (typeof event.data === "string") {
          terminal.reset();
          terminal.write(event.data);
        } else {
          terminal.write(new Uint8Array(event.data));
        }
      };
      ws.onclose = (event) => {
        if (disposed) return;
        if (event.code === CLOSE_NOT_FOUND) return setNotice("Tej sesji nie ma już w daemonie.");
        setNotice("Połączenie z terminalem sesji zerwane; łączenie ponownie…");
        timer = setTimeout(connect, RECONNECT_MS);
      };
    };
    connect();

    const input = terminal.onData((data) => send({ type: "input", data }));
    const resize = new ResizeObserver(() => {
      fit.fit();
      sendSize();
    });
    resize.observe(element);

    return () => {
      disposed = true;
      clearTimeout(timer);
      resize.disconnect();
      input.dispose();
      socket?.close();
      terminal.dispose();
    };
  }, [conn, session]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {notice && <p className="text-warning border-b px-3 py-1 text-xs">{notice}</p>}
      {!live && (
        <p className="text-muted-foreground border-b px-3 py-1 text-xs">Sesja się zakończyła; terminal pokazuje jej ostatni ekran.</p>
      )}
      <div ref={host} className="bg-background min-h-0 flex-1 p-2 font-mono" />
    </div>
  );
}
