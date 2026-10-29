import {
  agentsApi,
  type ConversationEntry,
  ConversationServerMessage,
  conversationSocket,
  PTY_CLOSE_NOT_FOUND,
  type Session,
} from "@trackwall/protocol";
import { SendHorizontal, Square } from "lucide-react";
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AgentDialogCard } from "@/components/AgentDialogCard";
import { StatusLabel } from "@/components/StatusLabel";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { sendsMessage, TOOL_STATUS, withEntries } from "@/lib/conversation";
import { daemonSocket } from "@/lib/daemon-socket";
import { KeyboardElsewhere } from "@/lib/keyboard-elsewhere";
import { isLive } from "@/lib/session-state";
import { browserTimers } from "@/lib/timers";
import { useAction } from "@/lib/use-action";
import { FocusReporter, terminalInFront } from "@/lib/window-focus";

const RECONNECT_MS = 1000;
/** How close to the end the list counts as followed: new entries scroll it along, otherwise the reader's place stays. */
const FOLLOW_PX = 48;

/**
 * The conversation view of a session (ADR-107), in place of its terminal: what the user and the agent said, the tools
 * the agent called, its approval, and a message box. The entries come over the conversation socket, all of them at
 * every connection; messages, answers and Stop go through the `agents` API. Everything is plain text in the page, so
 * scrolling, selecting and copying are the browser's own. Like the terminal, the view tells the daemon whether it is in
 * front of the user (ADR-47).
 */
export function ConversationView({ conn, session, selected }: { conn: Connection; session: Session; selected: boolean }) {
  const keyboardElsewhere = useContext(KeyboardElsewhere);
  const inFront = useRef(selected && !keyboardElsewhere);
  inFront.current = selected && !keyboardElsewhere;
  const updateFocus = useRef<() => void>(undefined);
  const [entries, setEntries] = useState<ConversationEntry[]>([]);
  const [notice, setNotice] = useState<string>();
  const list = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const id = session.id;

  useEffect(() => {
    let socket: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const focus = new FocusReporter(
      (focused) => {
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "focus", focused }));
      },
      () => terminalInFront(inFront.current, document),
      browserTimers,
    );
    const sendFocus = () => focus.update();
    updateFocus.current = sendFocus;
    const connect = () => {
      const { url, protocols } = daemonSocket(conn, conversationSocket(id), window.location);
      const ws = new WebSocket(url, protocols);
      socket = ws;
      ws.onopen = () => {
        setNotice(undefined);
        focus.connected();
      };
      ws.onmessage = (event: MessageEvent<string>) => {
        const message = ConversationServerMessage.safeParse(parseJson(event.data));
        if (message.success) setEntries((current) => withEntries(current, message.data));
      };
      ws.onclose = (event) => {
        if (disposed) return;
        if (event.code === PTY_CLOSE_NOT_FOUND) return setNotice("This session no longer exists in the daemon.");
        setNotice("Lost the connection to the conversation; reconnecting…");
        timer = setTimeout(connect, RECONNECT_MS);
      };
    };
    connect();
    window.addEventListener("focus", sendFocus);
    window.addEventListener("blur", sendFocus);
    document.addEventListener("visibilitychange", sendFocus);
    return () => {
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener("focus", sendFocus);
      window.removeEventListener("blur", sendFocus);
      document.removeEventListener("visibilitychange", sendFocus);
      focus.dispose();
      updateFocus.current = undefined;
      socket?.close();
    };
  }, [conn, id]);

  useEffect(() => {
    updateFocus.current?.();
  }, [selected, keyboardElsewhere]);

  // After the entries are in the page, before it is drawn: a followed list stays at its end.
  useLayoutEffect(() => {
    const element = list.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [entries]);

  const live = session.run.kind === "running";
  const working = live && (session.state?.state === "Working" || session.state?.state === "Approval");
  const ended = !isLive(session);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {notice && <p className="text-warning border-b px-3 py-1 text-xs">{notice}</p>}
      {ended && <p className="text-muted-foreground border-b px-3 py-1 text-xs">The session has ended; this is its conversation.</p>}
      <div
        ref={list}
        role="log"
        aria-label="Conversation"
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3 text-sm"
        onScroll={(e) => {
          const el = e.currentTarget;
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_PX;
        }}
      >
        {entries.length === 0 && <p className="text-muted-foreground">Write to the agent below.</p>}
        {entries.map((entry) => (
          <Entry key={entry.id} entry={entry} />
        ))}
      </div>
      {live && session.dialog && (
        <div className="border-t px-3 py-2">
          <AgentDialogCard key={`${id}:${session.dialog.id}`} conn={conn} session={id} dialog={session.dialog} onOpen={() => {}} />
        </div>
      )}
      <Composer conn={conn} session={id} live={live} working={working} focused={selected && !keyboardElsewhere} />
    </div>
  );
}

function Entry({ entry }: { entry: ConversationEntry }) {
  switch (entry.kind) {
    case "user":
      return <p className="bg-muted self-end rounded-md px-3 py-2 break-words whitespace-pre-wrap">{entry.text}</p>;
    case "agent":
      return <p className="break-words whitespace-pre-wrap">{entry.text}</p>;
    case "tool":
      return (
        <details className="rounded-md border px-3 py-1.5 text-xs">
          <summary className="flex cursor-pointer items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-medium">{entry.title}</span>
            <span className="text-muted-foreground">{entry.tool}</span>
            <StatusLabel {...TOOL_STATUS[entry.status]} />
          </summary>
          {entry.detail.length > 0 && (
            <pre className="bg-muted text-muted-foreground mt-1.5 max-h-64 overflow-auto rounded-sm px-2 py-1 font-mono break-all whitespace-pre-wrap">
              {entry.detail.join("\n")}
            </pre>
          )}
        </details>
      );
  }
}

/** The message box: Enter sends, Shift+Enter is a new line; a message written during a turn goes once it ends. Stop ends the turn. */
function Composer({
  conn,
  session,
  live,
  working,
  focused,
}: {
  conn: Connection;
  session: string;
  live: boolean;
  working: boolean;
  focused: boolean;
}) {
  const [text, setText] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  const say = useAction(
    (message: string) => post(conn, agentsApi.say, { session, text: message }),
    () => setText(""),
  );
  const stop = useAction(
    () => post(conn, agentsApi.interrupt, { session }),
    () => {},
  );
  useEffect(() => {
    if (focused) box.current?.focus();
  }, [focused]);
  const send = () => {
    if (text.trim() !== "" && !say.pending) say.run(text);
  };
  const error = say.error ?? stop.error;
  return (
    <div className="flex flex-col gap-1 border-t px-3 py-2">
      <div className="flex items-end gap-2">
        <Textarea
          ref={box}
          aria-label="Message to the agent"
          placeholder={live ? (working ? "Write the next message…" : "Write to the agent…") : "The session has ended"}
          value={text}
          disabled={!live}
          rows={2}
          className="max-h-48 min-h-0 flex-1 resize-none"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (!sendsMessage(e.nativeEvent)) return;
            e.preventDefault();
            send();
          }}
        />
        <div className="flex flex-col gap-1">
          <Button size="icon" aria-label="Send" title="Send (Enter)" disabled={!live || say.pending || text.trim() === ""} onClick={send}>
            <SendHorizontal />
          </Button>
          {working && (
            <Button
              size="icon"
              variant="outline"
              aria-label="Stop the turn"
              title="Stop the turn"
              disabled={stop.pending}
              onClick={() => stop.run()}
            >
              <Square />
            </Button>
          )}
        </div>
      </div>
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
