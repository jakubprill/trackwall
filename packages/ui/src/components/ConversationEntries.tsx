import type { AttachmentLabel, ConversationEntry, WaitingMessage } from "@trackwall/protocol";
import {
  Bot,
  Brain,
  ChevronRight,
  Clock,
  FileText,
  Globe,
  Image,
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
import { PatchLines } from "@/components/PatchLines";
import { StatusLabel } from "@/components/StatusLabel";
import type { Connection } from "@/lib/connection";
import { type ConversationTurn, conversationTurns, PATCH_SHOWN_LINES, TOOL_STATUS, toolSubtitle } from "@/lib/conversation";
import { changeLines } from "@/lib/diff-lines";

/**
 * The list of the conversation view (ADR-107): the user's messages as bubbles on the right, each agent turn as one block
 * under the agent's name with its answers as formatted Markdown, its thoughts folded and its tool calls as compact rows
 * that open their change in colour and their output, the user's waiting messages, and dots while the agent works.
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
          <UserMessage key={turn.entry.id} text={turn.entry.text} attachments={turn.entry.attachments} />
        ) : (
          <AgentTurn key={turn.id} conn={conn} turn={turn} streaming={working && at === turns.length - 1} />
        ),
      )}
      {working && <Working />}
      {waiting.map((message) => (
        <UserMessage key={message.id} text={message.text} attachments={message.attachments} waiting />
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

/**
 * The user's message with the names of what it attached; a waiting one (written during a turn) is dashed until the turn
 * ends and it goes.
 */
function UserMessage({ text, attachments, waiting = false }: { text: string; attachments: readonly AttachmentLabel[]; waiting?: boolean }) {
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
      {attachments.length > 0 && (
        <ul aria-label="Attached" className="flex flex-wrap justify-end gap-1.5 text-xs">
          {attachments.map((attachment, i) => {
            const Icon = attachment.kind === "image" ? Image : FileText;
            return (
              <li
                key={`${i}:${attachment.name}`}
                className="text-muted-foreground flex max-w-60 items-center gap-1 rounded-md border px-1.5 py-0.5"
              >
                <Icon className="text-primary size-3.5 shrink-0" aria-hidden />
                <span className="truncate">{attachment.name}</span>
              </li>
            );
          })}
        </ul>
      )}
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
        {turn.steps.map((step, at) => {
          const last = streaming && at === turn.steps.length - 1;
          if (step.kind === "tool") return <ToolCall key={step.id} tool={step} />;
          if (step.kind === "thought") return <Thought key={step.id} text={step.text} thinking={last} />;
          return <Answer key={step.id} conn={conn} text={step.text} streaming={last} />;
        })}
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

/** The model's reasoning, folded under one line, since it is there to check the agent rather than to read along. */
function Thought({ text, thinking }: { text: string; thinking: boolean }) {
  return (
    <details className="group text-muted-foreground text-xs">
      <summary className="hover:text-foreground flex w-fit cursor-pointer list-none items-center gap-1.5">
        <ChevronRight className="size-3 shrink-0 transition-transform group-open:rotate-90" aria-hidden />
        <Brain className="size-3.5 shrink-0" aria-hidden />
        {thinking ? "Thinking…" : "Thought"}
      </summary>
      <p className="mt-1.5 border-l pl-3 leading-relaxed break-words whitespace-pre-wrap italic">{text}</p>
    </details>
  );
}

/**
 * A tool call as one row: its kind's icon, title, the command of a shell tool or the files it works on, how many
 * lines it changes, and its state; the row opens its change in colour and its lines.
 */
function ToolCall({ tool }: { tool: Extract<ConversationEntry, { kind: "tool" }> }) {
  const Icon = tool.subagent ? Bot : (TOOL_ICONS[tool.tool] ?? Wrench);
  const subtitle = toolSubtitle(tool);
  const change = changeLines(tool.patch, PATCH_SHOWN_LINES, tool.patchCut);
  const opens = tool.detail.length > 0 || change.lines.length > 0 || tool.subagent !== null;
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
        <Icon className="text-primary size-3.5 shrink-0" aria-label={tool.subagent ? "subagent" : tool.tool} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium">{tool.title}</span>
          {subtitle && <span className="text-muted-foreground truncate font-mono">{subtitle}</span>}
        </span>
        {change.lines.length > 0 && <ChangeCount added={change.added} removed={change.removed} />}
        <StatusLabel {...TOOL_STATUS[tool.status]} />
      </summary>
      {tool.subagent && (
        <div className="border-t px-3 py-2">
          <p className="text-muted-foreground font-medium">Asked</p>
          <p className="break-words whitespace-pre-wrap">{tool.subagent.prompt}</p>
        </div>
      )}
      {change.lines.length > 0 && (
        <div className="max-h-96 overflow-auto border-t py-1.5">
          <PatchLines change={change} />
        </div>
      )}
      {tool.detail.length > 0 && (
        <pre className="text-muted-foreground max-h-64 overflow-auto border-t px-3 py-2 font-mono break-all whitespace-pre-wrap">
          {tool.detail.join("\n")}
        </pre>
      )}
    </details>
  );
}

/** How many lines a change adds and removes, as the "Changes" view counts them. */
function ChangeCount({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="shrink-0 font-mono" title={`${added} lines added, ${removed} removed`}>
      <span className="text-success">+{added}</span> <span className="text-destructive">−{removed}</span>
    </span>
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
