import type { ConversationEntry, WaitingMessage } from "@trackwall/protocol";
import {
  Bot,
  ChevronRight,
  Clock,
  FileText,
  Globe,
  type LucideIcon,
  MessageSquare,
  Pencil,
  Search,
  SquareTerminal,
  Trash2,
  User,
  Wrench,
} from "lucide-react";
import { type ReactNode, Suspense } from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { LazyMarkdown } from "@/components/LazyMarkdown";
import { StatusLabel } from "@/components/StatusLabel";
import type { Connection } from "@/lib/connection";
import { type ConversationTurn, conversationTurns, TOOL_STATUS } from "@/lib/conversation";

/**
 * The list of the conversation view (ADR-107): the user's messages as bubbles on the right, each agent turn as one block
 * under the agent's name with its answers as formatted Markdown and its tool calls as compact rows, the user's waiting
 * messages, and dots while the agent works.
 */

/** ACP's tool kinds as icons; any other kind is a wrench. */
const TOOL_ICONS: Partial<Record<string, LucideIcon>> = {
  read: FileText,
  edit: Pencil,
  execute: SquareTerminal,
  search: Search,
  fetch: Globe,
  delete: Trash2,
};

export function ConversationEntries({
  conn,
  entries,
  waiting,
  working,
}: {
  conn: Connection;
  entries: readonly ConversationEntry[];
  waiting: readonly WaitingMessage[];
  /** The agent is in a turn and asks nothing: dots after the last entry. */
  working: boolean;
}) {
  const turns = conversationTurns(entries);
  if (turns.length === 0 && waiting.length === 0)
    return (
      <div className="text-muted-foreground m-auto flex flex-col items-center gap-2 text-center">
        <MessageSquare className="size-6" aria-hidden />
        <p>Write to the agent below.</p>
      </div>
    );
  return (
    <>
      {turns.map((turn, at) =>
        turn.kind === "user" ? (
          <UserMessage key={turn.entry.id} text={turn.entry.text} />
        ) : (
          <AgentTurn key={turn.id} conn={conn} turn={turn} streaming={working && at === turns.length - 1} />
        ),
      )}
      {working && <Working />}
      {waiting.map((message) => (
        <UserMessage key={message.id} text={message.text} waiting />
      ))}
    </>
  );
}

function Speaker({ icon: Icon, name, align }: { icon: LucideIcon; name: string; align: "start" | "end" }) {
  return (
    <span className={align === "end" ? "flex items-center gap-1.5 self-end" : "flex items-center gap-1.5"}>
      <span className="bg-accent text-primary flex size-5 items-center justify-center rounded-full">
        <Icon className="size-3" aria-hidden />
      </span>
      <span className="hud-label">{name}</span>
    </span>
  );
}

/** The user's message; a waiting one (written during a turn) is dashed until the turn ends and it goes. */
function UserMessage({ text, waiting = false }: { text: string; waiting?: boolean }) {
  return (
    <div className="flex max-w-3/4 flex-col items-end gap-1.5 self-end">
      <Speaker icon={User} name="You" align="end" />
      <p
        className={
          waiting
            ? "text-muted-foreground rounded-lg rounded-tr-sm border border-dashed px-3.5 py-2 break-words whitespace-pre-wrap"
            : "bg-secondary text-secondary-foreground rounded-lg rounded-tr-sm border px-3.5 py-2 break-words whitespace-pre-wrap"
        }
      >
        {text}
      </p>
      {waiting && (
        <span className="text-muted-foreground flex items-center gap-1 text-xs">
          <Clock className="size-3" aria-hidden />
          Waiting: sent when the agent's turn ends
        </span>
      )}
    </div>
  );
}

function AgentTurn({
  conn,
  turn,
  streaming,
}: {
  conn: Connection;
  turn: Extract<ConversationTurn, { kind: "agent" }>;
  streaming: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Speaker icon={Bot} name="Agent" align="start" />
      <div className="border-accent flex flex-col gap-2 border-l-2 pl-3">
        {turn.steps.map((step, at) =>
          step.kind === "tool" ? (
            <ToolCall key={step.id} tool={step} />
          ) : (
            <Answer key={step.id} conn={conn} text={step.text} streaming={streaming && at === turn.steps.length - 1} />
          ),
        )}
      </div>
    </div>
  );
}

/** Until Streamdown has loaded, or if it fails, the answer is plain text. */
function Answer({ conn, text, streaming }: { conn: Connection; text: string; streaming: boolean }) {
  const plain = <PlainAnswer text={text} />;
  return (
    <ErrorBoundary fallback={() => plain}>
      <Suspense fallback={plain}>
        <LazyMarkdown conn={conn} text={text} source="agent" streaming={streaming} />
      </Suspense>
    </ErrorBoundary>
  );
}

function PlainAnswer({ text }: { text: string }): ReactNode {
  return <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">{text}</p>;
}

/** A tool call as one row: its kind's icon, title, the command of a shell tool, and its state; the row opens its lines. */
function ToolCall({ tool }: { tool: Extract<ConversationEntry, { kind: "tool" }> }) {
  const Icon = TOOL_ICONS[tool.tool] ?? Wrench;
  const command = tool.tool === "execute" ? tool.detail.find((line) => line.startsWith("$ ")) : undefined;
  const opens = tool.detail.length > 0;
  return (
    <details className="group bg-muted rounded-md border text-xs">
      <summary
        className={
          opens
            ? "hover:bg-accent flex cursor-pointer list-none items-center gap-2 rounded-md px-2.5 py-1.5"
            : "flex list-none items-center gap-2 px-2.5 py-1.5"
        }
      >
        <ChevronRight
          className={
            opens ? "text-muted-foreground size-3 shrink-0 transition-transform group-open:rotate-90" : "invisible size-3 shrink-0"
          }
          aria-hidden
        />
        <Icon className="text-primary size-3.5 shrink-0" aria-label={tool.tool} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium">{tool.title}</span>
          {command && <span className="text-muted-foreground truncate font-mono">{command}</span>}
        </span>
        <StatusLabel {...TOOL_STATUS[tool.status]} />
      </summary>
      {opens && (
        <pre className="text-muted-foreground max-h-64 overflow-auto border-t px-3 py-2 font-mono break-all whitespace-pre-wrap">
          {tool.detail.join("\n")}
        </pre>
      )}
    </details>
  );
}

/** Three dots while the agent works on its turn; the line above the message box says it in words. */
function Working() {
  return (
    <div className="flex items-center gap-1 pl-3.5" aria-hidden>
      <span className="bg-primary size-1.5 animate-pulse rounded-full" />
      <span className="bg-primary size-1.5 animate-pulse rounded-full" />
      <span className="bg-primary size-1.5 animate-pulse rounded-full" />
    </div>
  );
}
