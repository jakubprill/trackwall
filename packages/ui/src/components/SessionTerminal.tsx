import "@xterm/xterm/css/xterm.css";
import { isTauri } from "@tauri-apps/api/core";
import { PTY_CLOSE_NOT_FOUND, type PtyClientMessage, ptySocket } from "@trackwall/protocol";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/xterm";
import { useContext, useEffect, useRef, useState } from "react";
import { errorMessage } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import type { Connection } from "@/lib/connection";
import { daemonSocket } from "@/lib/daemon-socket";
import { useOpenWebLink } from "@/lib/desktop";
import { DROP_HOVER_RING, FILE_DROP_TARGET, FileDropEvent } from "@/lib/file-drop";
import { InputBeforeOpen } from "@/lib/input-before-open";
import { KeyboardElsewhere } from "@/lib/keyboard-elsewhere";
import { useLastScreens } from "@/lib/last-screens";
import { oncePerFrame } from "@/lib/once-per-frame";
import { pastedPaths } from "@/lib/pasted-paths";
import { IS_MAC } from "@/lib/platform";
import { asksProgramToCopy, copiesSelection, keepsSelection, osc52Text, ProgramCopy, pastesClipboard } from "@/lib/terminal-copy";
import { hyperlinkHandler, trackwallLinkProvider } from "@/lib/terminal-links";
import { sessionTerminalOptions } from "@/lib/terminal-options";
import { cssTokens, terminalTheme } from "@/lib/terminal-theme";
import { browserTimers } from "@/lib/timers";
import { cn } from "@/lib/utils";
import { FocusReporter, terminalInFront } from "@/lib/window-focus";

const RECONNECT_MS = 1000;
const KEYS_DROPPED = "The terminal was still connecting to the session, so some of the keys you typed were dropped.";
const COPY_FAILED = "Could not copy the selection to the clipboard; select the text again.";
/** OSC 52: the program sets the clipboard (`osc52Text`). */
const OSC_CLIPBOARD = 52;
/** A screen image that comes sooner than this needs no word about it; the label would only flash. */
const CONNECTING_LABEL_MS = 300;
/** RIS: xterm.js resets the whole terminal, as `Terminal.reset` does, at this point of the output. */
const RESET = "\x1bc";

/**
 * The session terminal of one session (§4.4, ADR-26): xterm.js connected over a WebSocket to the PTY in the daemon. The
 * daemon sends the screen image first, so switching sessions or a dropped connection starts from the current screen,
 * not an empty terminal. Keys and the terminal size go to the session; the PTY takes the size of the last session
 * terminal that reported one, and a window that comes to the front reports its terminals' sizes again, so with the
 * session open in two windows (ADR-49) the one you work in sets it. The window also tells the daemon whether it is in front of the user, which marks the session seen
 * (ADR-47). In the grid (ADR-48) several terminals are open at once; only the `selected` one takes the keyboard and
 * counts as in front, so a waiting session in another tile keeps waiting until the user selects it. Files dropped on
 * the terminal (ADR-51) are pasted as their paths, as if the user typed them. Keys typed before the first connection
 * opens wait for it (`InputBeforeOpen`). Text the program copies (OSC 52, how Copilot CLI copies its own selection) goes
 * to the clipboard only as the answer to the user's Ctrl+C or right click in this terminal (`asksProgramToCopy`).
 * Until the daemon's screen image comes, the terminal shows the screen it had when it last closed in this window, and
 * says it is connecting (ADR-117): where the daemon answers late, the frame would otherwise stay black for seconds.
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
  const [connecting, setConnecting] = useState(false);
  const lastScreens = useLastScreens();
  // Through a ref: whether the daemon has a desktop arrives after the terminal opens, and must not open it again.
  const openLink = useOpenWebLink(conn);
  const openWebLink = useRef(openLink);
  openWebLink.current = openLink;

  useEffect(() => {
    const element = host.current;
    const container = frame.current;
    if (!element || !container) return;
    const terminal = new Terminal(
      sessionTerminalOptions(terminalTheme(cssTokens(document.documentElement)), getComputedStyle(element).fontFamily),
    );
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    const serializer = new SerializeAddon();
    terminal.loadAddon(serializer);
    let links: { dispose: () => void } | undefined;
    if (isTauri()) {
      links = terminal.registerLinkProvider(trackwallLinkProvider(terminal, IS_MAC));
      terminal.options.linkHandler = hyperlinkHandler(IS_MAC, (url) => {
        openWebLink.current(url).catch((err: unknown) => setNotice(`Could not open the link: ${errorMessage(err)}`));
      });
    }
    terminal.open(element);
    // In the capture phase, before xterm.js reports the move to the program and so clears the selection.
    const holdMove = (event: MouseEvent) => {
      const state = { hasSelection: terminal.hasSelection(), reportsMoves: terminal.modes.mouseTrackingMode === "any" };
      if (keepsSelection(event, state)) event.stopPropagation();
    };
    element.addEventListener("mousemove", holdMove, { capture: true });
    const programCopy = new ProgramCopy();
    const selection = () => ({ mac: IS_MAC, hasSelection: terminal.hasSelection() });
    const noteClick = (event: PointerEvent) => {
      if (asksProgramToCopy({ kind: "pointer", button: event.button }, selection())) programCopy.asked(performance.now());
    };
    element.addEventListener("pointerdown", noteClick, { capture: true });
    const copyHandler = terminal.parser.registerOscHandler(OSC_CLIPBOARD, (data) => {
      const text = osc52Text(data);
      if (text !== undefined && programCopy.take(performance.now())) copyText(text).catch(() => setNotice(COPY_FAILED));
      return true;
    });
    fit.fit();
    const kept = lastScreens.shown(session, terminal.cols);
    if (kept !== undefined) terminal.write(kept);
    let screenCame = false;
    const slowScreen = setTimeout(() => setConnecting(true), CONNECTING_LABEL_MS);
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
      browserTimers,
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
          // A reset in the stream, not `terminal.reset()`: the kept screen may still wait in xterm.js's write queue, and
          // a reset outside it would leave that rest to be drawn under the image.
          terminal.write(`${RESET}${event.data}`);
          screenCame = true;
          clearTimeout(slowScreen);
          setConnecting(false);
        } else {
          terminal.write(new Uint8Array(event.data));
        }
      };
      ws.onclose = (event) => {
        if (disposed) return;
        if (event.code === PTY_CLOSE_NOT_FOUND) {
          clearTimeout(slowScreen);
          setConnecting(false);
          return setNotice("This session no longer exists in the daemon.");
        }
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
      if (asksProgramToCopy({ kind: "key", key: event }, selection())) programCopy.asked(performance.now());
      // `false` without `preventDefault`: xterm.js leaves the key alone and the browser pastes into its text area.
      if (pastesClipboard(event, { mac: IS_MAC })) return false;
      if (!copiesSelection(event, { mac: IS_MAC, hasSelection: terminal.hasSelection() })) return true;
      // Without this the browser also runs its own shortcut: Ctrl+Shift+C opens the inspector in Chrome and in WebView2 in dev mode.
      event.preventDefault();
      copyText(terminal.getSelection()).then(
        () => terminal.clearSelection(),
        () => setNotice(COPY_FAILED),
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
      clearTimeout(slowScreen);
      // Only a screen the daemon sent: one still waiting for it shows the kept screen, which stays kept as it is. Without
      // the modes: the kept screen is a picture to look at until the image comes, not a mouse mode to type in.
      if (screenCame)
        lastScreens.keep(session, { cols: terminal.cols, screen: serializer.serialize({ scrollback: 0, excludeModes: true }) });
      resizer.dispose();
      resize.disconnect();
      container.removeEventListener(FileDropEvent.type, takeDrop);
      element.removeEventListener("mousemove", holdMove, { capture: true });
      element.removeEventListener("pointerdown", noteClick, { capture: true });
      copyHandler.dispose();
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
  }, [conn, session, lastScreens]);

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
      <div ref={frame} {...{ [FILE_DROP_TARGET]: "" }} className={cn("relative min-h-0 flex-1 overflow-hidden", DROP_HOVER_RING)}>
        <div ref={host} className="absolute inset-2 font-mono" />
        {/* Over the terminal, not above it: a bar in the flow would shrink the terminal and make the TUI redraw. */}
        {connecting && (
          <p className="bg-card text-muted-foreground pointer-events-none absolute right-4 bottom-4 rounded-md border px-3 py-1 text-xs shadow-lg">
            Connecting to the session…
          </p>
        )}
      </div>
    </div>
  );
}
