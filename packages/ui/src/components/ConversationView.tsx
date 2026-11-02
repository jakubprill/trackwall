import {
  agentsApi,
  type ConversationEntry,
  type ConversationInfo,
  ConversationServerMessage,
  conversationSocket,
  PTY_CLOSE_NOT_FOUND,
  type Session,
  type SlashCommand,
  type WaitingMessage,
} from "@trackwall/protocol";
import { SendHorizontal, Square } from "lucide-react";
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AgentDialogCard } from "@/components/AgentDialogCard";
import { AgentModeSwitch } from "@/components/AgentModeSwitch";
import { ContextMeter } from "@/components/ContextMeter";
import { ConversationEntries } from "@/components/ConversationEntries";
import { AttachButton, AttachmentChips, useMessageAttachments } from "@/components/MessageAttachments";
import { SlashCommandList } from "@/components/SlashCommandList";
import { StatusLabel } from "@/components/StatusLabel";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import {
  conversationStatus,
  NO_CONVERSATION_INFO,
  sendsMessage,
  slashSuggestions,
  withConversationInfo,
  withEntries,
  withSlashCommand,
} from "@/lib/conversation";
import { daemonSocket } from "@/lib/daemon-socket";
import { KeyboardElsewhere } from "@/lib/keyboard-elsewhere";
import { inTurn, isLive } from "@/lib/session-state";
import { browserTimers } from "@/lib/timers";
import { useAction } from "@/lib/use-action";
import { FocusReporter, terminalInFront } from "@/lib/window-focus";

const RECONNECT_MS = 1000;
/** How close to the end the list counts as followed: new entries scroll it along, otherwise the reader's place stays. */
const FOLLOW_PX = 48;

/**
 * The conversation view of a session (ADR-107), in place of its terminal: what the user and the agent said, the tools
 * the agent called, its approval, whose turn it is with the agent's mode and context use, and a message box that suggests
 * the agent's slash commands. The user's messages that wait for the turn to end
 * show at once, as waiting, until they go. The entries come over the conversation socket, all of them at
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
  const [waiting, setWaiting] = useState<WaitingMessage[]>([]);
  const [info, setInfo] = useState<ConversationInfo>(NO_CONVERSATION_INFO);
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
        if (!message.success) return;
        setEntries((current) => withEntries(current, message.data));
        setInfo((current) => withConversationInfo(current, message.data));
        setWaiting(message.data.waiting);
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
  }, [entries, waiting]);

  const live = session.run.kind === "running";
  const working = inTurn(session);
  const ended = !isLive(session);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {notice && <p className="text-warning border-b px-3 py-1 text-xs">{notice}</p>}
      {ended && <p className="text-muted-foreground border-b px-3 py-1 text-xs">The session has ended; this is its conversation.</p>}
      <div
        ref={list}
        role="log"
        aria-label="Conversation"
        className="flex min-h-0 flex-1 flex-col overflow-y-auto text-sm"
        onScroll={(e) => {
          const el = e.currentTarget;
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_PX;
        }}
      >
        {/* A column of reading width in the middle, so that a wide panel does not stretch lines across the screen. */}
        <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 px-4 py-4">
          <ConversationEntries conn={conn} entries={entries} waiting={live ? waiting : []} working={working && !session.dialog} />
        </div>
      </div>
      {live && session.dialog && (
        <div className="border-t px-3 py-2">
          <AgentDialogCard key={`${id}:${session.dialog.id}`} conn={conn} session={id} dialog={session.dialog} onOpen={() => {}} />
        </div>
      )}
      {live && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 pt-2 text-xs">
          <p role="status" aria-label="Whose turn" className="min-w-0 flex-1">
            <StatusLabel {...conversationStatus(session)} />
          </p>
          {info.mode && <AgentModeSwitch conn={conn} session={id} mode={info.mode} />}
          {info.context && <ContextMeter context={info.context} />}
        </div>
      )}
      {live && <Composer conn={conn} session={id} working={working} focused={selected && !keyboardElsewhere} commands={info.commands} />}
    </div>
  );
}

/**
 * The message box of a running session: Enter sends, Shift+Enter is a new line; a message written during a turn goes
 * once it ends. Stop ends the turn. The box grows with the text, and its buttons sit inside it on one line. A slash at
 * its start lists the agent's commands, which ↑, ↓ and Tab or Enter pick and Esc closes.
 */
function Composer({
  conn,
  session,
  working,
  focused,
  commands,
}: {
  conn: Connection;
  session: string;
  working: boolean;
  focused: boolean;
  commands: readonly SlashCommand[];
}) {
  const [text, setText] = useState("");
  const [picked, setPicked] = useState(0);
  const [listClosed, setListClosed] = useState(false);
  const suggestions = listClosed ? [] : slashSuggestions(text, commands);
  const pick = (command: SlashCommand) => {
    setText(withSlashCommand(command));
    setPicked(0);
  };
  const box = useRef<HTMLTextAreaElement>(null);
  const files = useMessageAttachments();
  const say = useAction(
    (message: string) => post(conn, agentsApi.say, { session, text: message, attachments: files.attachments }),
    () => {
      setText("");
      files.clear();
    },
  );
  const stop = useAction(
    () => post(conn, agentsApi.interrupt, { session }),
    () => {},
  );
  useEffect(() => {
    if (focused) box.current?.focus();
  }, [focused]);
  // The box grows with the text up to its max-h. Set from the script, since CSS `field-sizing` is missing in older
  // WebKit, which the desktop shell uses on macOS.
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [text]);
  const send = () => {
    if (text.trim() !== "" && !say.pending) say.run(text);
  };
  const error = say.error ?? stop.error ?? files.problem;
  return (
    <div className="flex flex-col gap-1 px-3 pt-1 pb-2">
      {suggestions.length > 0 && <SlashCommandList commands={suggestions} selected={picked} onPick={pick} />}
      {files.attachments.length > 0 && <AttachmentChips attachments={files.attachments} label="Attachments" onRemove={files.remove} />}
      <div className="border-input dark:bg-muted focus-within:border-ring focus-within:ring-ring/50 flex items-end gap-2 rounded-md border py-1.5 pr-1.5 pl-3 focus-within:ring-[3px]">
        <textarea
          ref={box}
          aria-label="Message to the agent"
          placeholder={working ? "Write the next message…" : "Write to the agent…"}
          value={text}
          rows={1}
          className="placeholder:text-muted-foreground max-h-48 min-w-0 flex-1 resize-none self-center bg-transparent py-1 text-sm outline-none"
          onPaste={(e) => {
            // A pasted screenshot or file is an attachment; pasted text stays text.
            const pasted = [...e.clipboardData.files];
            if (pasted.length === 0) return;
            e.preventDefault();
            void files.add(pasted);
          }}
          onChange={(e) => {
            setText(e.target.value);
            setPicked(0);
            setListClosed(false);
          }}
          onKeyDown={(e) => {
            if (suggestions.length > 0 && slashKey(e.key, suggestions.length, picked, setPicked, setListClosed)) {
              e.preventDefault();
              const command = suggestions[Math.min(picked, suggestions.length - 1)];
              if ((e.key === "Tab" || e.key === "Enter") && command) pick(command);
              return;
            }
            if (!sendsMessage(e.nativeEvent)) return;
            e.preventDefault();
            send();
          }}
        />
        <AttachButton onFiles={(picked) => void files.add(picked)} />
        {working && (
          <Button size="sm" variant="outline" title="Stop the turn; the session goes on" disabled={stop.pending} onClick={() => stop.run()}>
            <Square /> Stop the turn
          </Button>
        )}
        <Button
          size="icon"
          className="size-8"
          aria-label="Send"
          title="Send (Enter)"
          disabled={say.pending || text.trim() === ""}
          onClick={send}
        >
          <SendHorizontal />
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        Enter sends, Shift+Enter is a new line, and a pasted screenshot is attached
        {working ? "; a message written now goes when the turn ends" : ""}
      </p>
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}

/** A key while the slash commands show: ↑ and ↓ move the pick, Esc closes the list; whether the list took the key. */
function slashKey(
  key: string,
  count: number,
  picked: number,
  setPicked: (i: number) => void,
  setListClosed: (closed: boolean) => void,
): boolean {
  if (key === "ArrowDown") setPicked((picked + 1) % count);
  else if (key === "ArrowUp") setPicked((picked - 1 + count) % count);
  else if (key === "Escape") setListClosed(true);
  else return key === "Tab" || key === "Enter";
  return true;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
