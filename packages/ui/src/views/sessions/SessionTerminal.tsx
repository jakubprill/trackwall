import "@xterm/xterm/css/xterm.css";
import { PTY_CLOSE_NOT_FOUND, type PtyClientMessage, ptySocket } from "@trackwall/protocol";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import type { Connection } from "@/lib/connection";
import { daemonSocket } from "@/lib/daemon-socket";
import { oncePerFrame } from "@/lib/once-per-frame";
import { IS_MAC } from "@/lib/platform";
import { copiesSelection } from "@/lib/terminal-copy";
import { sessionTerminalOptions } from "@/lib/terminal-options";
import { terminalTheme } from "@/lib/terminal-theme";
import { FocusReporter, terminalInFront } from "@/lib/window-focus";

const RECONNECT_MS = 1000;

/**
 * The terminal window of one session (§4.4, ADR-26): xterm.js connected over a WebSocket to the PTY in the daemon. The
 * daemon sends the screen image first, so switching sessions or a dropped connection starts from the current screen,
 * not an empty terminal. Keys and the window size go to the session; the PTY takes the size of the last window that
 * reported one, and a window that comes to the front reports its size again, so with the session open in two windows
 * (ADR-49) the one you work in sets it. The window also tells the daemon whether it is in front of the user, which marks the session seen
 * (ADR-47). In the grid (ADR-48) several terminals are open at once; only the `focused` one takes the keyboard and
 * counts as in front, so a waiting session in another tile keeps waiting until the user selects it.
 */
export function SessionTerminal({ conn, session, live, focused }: { conn: Connection; session: string; live: boolean; focused: boolean }) {
  const frame = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal>(undefined);
  const takesFocus = useRef(focused);
  takesFocus.current = focused;
  const updateFocus = useRef<() => void>(undefined);
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    const element = host.current;
    const container = frame.current;
    if (!element || !container) return;
    const terminal = new Terminal(sessionTerminalOptions(terminalTheme(document.documentElement), getComputedStyle(element).fontFamily));
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);
    fit.fit();
    term.current = terminal;
    if (takesFocus.current) terminal.focus();

    let socket: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const send = (message: PtyClientMessage) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };
    const sendSize = () => send({ type: "resize", cols: terminal.cols, rows: terminal.rows });
    const focus = new FocusReporter(
      (inFront) => send({ type: "focus", focused: inFront }),
      () => terminalInFront(takesFocus.current, document),
      { set: (run, ms) => setTimeout(run, ms), clear: (focusTimer) => clearTimeout(focusTimer) },
    );
    const sendFocus = () => focus.update();
    updateFocus.current = sendFocus;
    const onWindowFocus = () => {
      sendSize();
      sendFocus();
    };

    const connect = () => {
      const { url, protocols } = daemonSocket(conn, ptySocket(session), window.location);
      const ws = new WebSocket(url, protocols);
      ws.binaryType = "arraybuffer";
      socket = ws;
      ws.onopen = () => {
        setNotice(undefined);
        sendSize();
        focus.connected();
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
        if (event.code === PTY_CLOSE_NOT_FOUND) return setNotice("This session no longer exists in the daemon.");
        setNotice("Lost the connection to the session terminal; reconnecting…");
        timer = setTimeout(connect, RECONNECT_MS);
      };
    };
    connect();

    const input = terminal.onData((data) => send({ type: "input", data }));
    terminal.attachCustomKeyEventHandler((event) => {
      if (!copiesSelection(event, { mac: IS_MAC, hasSelection: terminal.hasSelection() })) return true;
      // Bez tego przeglądarka wykona też własny skrót: Ctrl+Shift+C otwiera inspektor w Chrome i WebView2 w trybie dev.
      event.preventDefault();
      navigator.clipboard.writeText(terminal.getSelection()).then(
        () => terminal.clearSelection(),
        () => setNotice("Nie udało się skopiować zaznaczenia do schowka; zaznacz tekst jeszcze raz."),
      );
      return false;
    });
    const resizer = oncePerFrame(() => {
      const { cols, rows } = terminal;
      fit.fit();
      if (terminal.cols !== cols || terminal.rows !== rows) sendSize();
    });
    // Obserwowana jest ramka, której rozmiar wynika tylko z układu strony; terminal leży w niej absolutnie, więc jego
    // wymiary nie zmieniają ramki ani nie wywołują pasków przewijania strony. Odstęp od brzegu to `inset`, nie
    // `padding` kontenera: FitAddon liczy miejsce z rozmiaru kontenera i nie odejmuje jego paddingu.
    const resize = new ResizeObserver(() => resizer.request());
    resize.observe(container);
    window.addEventListener("focus", onWindowFocus);
    window.addEventListener("blur", sendFocus);
    document.addEventListener("visibilitychange", sendFocus);

    return () => {
      disposed = true;
      clearTimeout(timer);
      resizer.dispose();
      resize.disconnect();
      window.removeEventListener("focus", onWindowFocus);
      window.removeEventListener("blur", sendFocus);
      document.removeEventListener("visibilitychange", sendFocus);
      focus.dispose();
      input.dispose();
      socket?.close();
      term.current = undefined;
      updateFocus.current = undefined;
      terminal.dispose();
    };
  }, [conn, session]);

  useEffect(() => {
    if (focused) term.current?.focus();
    updateFocus.current?.();
  }, [focused]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {notice && <p className="text-warning border-b px-3 py-1 text-xs">{notice}</p>}
      {!live && (
        <p className="text-muted-foreground border-b px-3 py-1 text-xs">
          The session has ended; the terminal shows what was left on its screen.
        </p>
      )}
      <div ref={frame} className="bg-background relative min-h-0 flex-1 overflow-hidden">
        <div ref={host} className="absolute inset-2 font-mono" />
      </div>
    </div>
  );
}
