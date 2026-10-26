import "@xterm/xterm/css/xterm.css";
import { isTauri } from "@tauri-apps/api/core";
import { PTY_CLOSE_NOT_FOUND, type PtyClientMessage, ptySocket, workspaceApi } from "@trackwall/protocol";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useContext, useEffect, useRef, useState } from "react";
import { errorMessage, post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { daemonSocket } from "@/lib/daemon-socket";
import { DROP_HOVER_RING, FILE_DROP_TARGET, FileDropEvent } from "@/lib/file-drop";
import { InputBeforeOpen } from "@/lib/input-before-open";
import { KeyboardElsewhere } from "@/lib/keyboard-elsewhere";
import { oncePerFrame } from "@/lib/once-per-frame";
import { pastedPaths } from "@/lib/pasted-paths";
import { IS_MAC } from "@/lib/platform";
import { copiesSelection, keepsSelection, pastesClipboard } from "@/lib/terminal-copy";
import { hyperlinkHandler, trackwallLinkProvider } from "@/lib/terminal-links";
import { sessionTerminalOptions } from "@/lib/terminal-options";
import { terminalTheme } from "@/lib/terminal-theme";
import { cn } from "@/lib/utils";
import { FocusReporter, terminalInFront } from "@/lib/window-focus";

const RECONNECT_MS = 1000;
const KEYS_DROPPED = "The terminal was still connecting to the session, so some of the keys you typed were dropped.";

/**
 * The session terminal of one session (§4.4, ADR-26): xterm.js connected over a WebSocket to the PTY in the daemon. The
 * daemon sends the screen image first, so switching sessions or a dropped connection starts from the current screen,
 * not an empty terminal. Keys and the terminal size go to the session; the PTY takes the size of the last session
 * terminal that reported one, and a window that comes to the front reports its terminals' sizes again, so with the
 * session open in two windows (ADR-49) the one you work in sets it. The window also tells the daemon whether it is in front of the user, which marks the session seen
 * (ADR-47). In the grid (ADR-48) several terminals are open at once; only the `selected` one takes the keyboard and
 * counts as in front, so a waiting session in another tile keeps waiting until the user selects it. Files dropped on
 * the terminal (ADR-51) are pasted as their paths, as if the user typed them. Keys typed before the first connection
 * opens wait for it (`InputBeforeOpen`).
 */
export function SessionTerminal({
  conn,
  session,
  live,
  selected,
}: {
  conn: Connection;
  session: string;
  live: boolean;
  selected: boolean;
}) {
  const keyboardElsewhere = useContext(KeyboardElsewhere);
  const focused = selected && !keyboardElsewhere;
  const frame = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal>(undefined);
  const takesFocus = useRef(focused);
  takesFocus.current = focused;
  const isLive = useRef(live);
  isLive.current = live;
  const updateFocus = useRef<() => void>(undefined);
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    const element = host.current;
    const container = frame.current;
    if (!element || !container) return;
    const terminal = new Terminal(sessionTerminalOptions(terminalTheme(document.documentElement), getComputedStyle(element).fontFamily));
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    let links: { dispose: () => void } | undefined;
    if (isTauri()) {
      links = terminal.registerLinkProvider(trackwallLinkProvider(terminal, IS_MAC));
      terminal.options.linkHandler = hyperlinkHandler(IS_MAC, (url) => {
        post(conn, workspaceApi.openLink, { url }).catch((err: unknown) => setNotice(`Could not open the link: ${errorMessage(err)}`));
      });
    }
    terminal.open(element);
    // In the capture phase, before xterm.js reports the move to the program and so clears the selection.
    const holdMove = (event: MouseEvent) => {
      const state = { hasSelection: terminal.hasSelection(), reportsMoves: terminal.modes.mouseTrackingMode === "any" };
      if (keepsSelection(event, state)) event.stopPropagation();
    };
    element.addEventListener("mousemove", holdMove, { capture: true });
    fit.fit();
    term.current = terminal;
    if (takesFocus.current) terminal.focus();

    let socket: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const early = new InputBeforeOpen();
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
        const held = early.open();
        setNotice(held.dropped ? KEYS_DROPPED : undefined);
        sendSize();
        for (const data of held.keys) send({ type: "input", data });
        focus.connected();
      };
      ws.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
        // A text frame is the screen image at the start of the connection: it replaces what the window showed before.
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
        setNotice(
          early.fail()
            ? "Could not connect to the session terminal, so the keys you typed were dropped; reconnecting…"
            : "Lost the connection to the session terminal; reconnecting…",
        );
        timer = setTimeout(connect, RECONNECT_MS);
      };
    };
    connect();

    const input = terminal.onData((data) => {
      const taken = early.take(data);
      if (taken === "send") send({ type: "input", data });
      else if (taken === "dropped") setNotice(KEYS_DROPPED);
    });
    terminal.attachCustomKeyEventHandler((event) => {
      // `false` without `preventDefault`: xterm.js leaves the key alone and the browser pastes into its text area.
      if (pastesClipboard(event, { mac: IS_MAC })) return false;
      if (!copiesSelection(event, { mac: IS_MAC, hasSelection: terminal.hasSelection() })) return true;
      // Without this the browser also runs its own shortcut: Ctrl+Shift+C opens the inspector in Chrome and in WebView2 in dev mode.
      event.preventDefault();
      navigator.clipboard.writeText(terminal.getSelection()).then(
        () => terminal.clearSelection(),
        () => setNotice("Could not copy the selection to the clipboard; select the text again."),
      );
      return false;
    });
    const takeDrop = (event: Event) => {
      if (!(event instanceof FileDropEvent)) return;
      if (!isLive.current) return setNotice("The session has ended, so the dropped path was not pasted.");
      // `paste` goes through `onData`, and in bracketed paste mode the agent sees it as pasted text, not keys.
      terminal.paste(pastedPaths(event.paths));
    };
    container.addEventListener(FileDropEvent.type, takeDrop);
    const resizer = oncePerFrame(() => {
      const { cols, rows } = terminal;
      fit.fit();
      if (terminal.cols !== cols || terminal.rows !== rows) sendSize();
    });
    // The observed element is a frame whose size comes only from the page layout; the terminal lies in it absolutely, so its
    // dimensions neither change the frame nor cause page scroll bars. The distance from the edge is `inset`, not the
    // container's `padding`: FitAddon computes the space from the container's size and does not subtract its padding.
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
      container.removeEventListener(FileDropEvent.type, takeDrop);
      element.removeEventListener("mousemove", holdMove, { capture: true });
      window.removeEventListener("focus", onWindowFocus);
      window.removeEventListener("blur", sendFocus);
      document.removeEventListener("visibilitychange", sendFocus);
      focus.dispose();
      input.dispose();
      links?.dispose();
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
      <div
        ref={frame}
        {...{ [FILE_DROP_TARGET]: "" }}
        className={cn("bg-background relative min-h-0 flex-1 overflow-hidden", DROP_HOVER_RING)}
      >
        <div ref={host} className="absolute inset-2 font-mono" />
      </div>
    </div>
  );
}
