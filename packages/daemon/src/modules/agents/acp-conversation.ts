import { CONVERSATION_TEXT_MAX, type ConversationEntry, TOOL_KIND_MAX, TOOL_TITLE_MAX } from "@trackwall/protocol";
import { contentText, type SessionUpdate, type ToolCallContent } from "./acp-messages.ts";

/**
 * The conversation of a session in the conversation view (ADR-107), built from ACP's `session/update` notifications:
 * message chunks join into one entry until the other side speaks or a tool runs, and a tool call's updates change its
 * entry. `apply` returns the entries an update changed, which go to the conversation sockets as they are. Everything
 * the agent sends is cut to the protocol's limits, and the oldest entries go once the conversation outgrows its budget,
 * so one answer or a long session cannot fill the daemon's memory or a socket's first frame.
 */

/** The most lines of a tool call's detail kept; a long diff or output is cut at the end. */
const DETAIL_LINES_MAX = 400;
/** The most characters of a tool call's detail kept. */
const DETAIL_CHARS_MAX = 64 * 1024;
/** The most entries kept, and the most characters in all of them; beyond either, the oldest go. */
const ENTRIES_MAX = 1000;
const CONVERSATION_CHARS_MAX = 4 * 1024 * 1024;

/** The entries an update changed, or `reset` when old entries went and the views get all of them again. */
export interface ConversationChange {
  entries: readonly ConversationEntry[];
  reset: boolean;
}

type ToolEntry = Extract<ConversationEntry, { kind: "tool" }>;
type ToolUpdate = Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>;

export class AcpConversation {
  readonly #entries: ConversationEntry[] = [];
  readonly #tools = new Map<string, ToolEntry>();
  #nextId = 1;

  entries(): readonly ConversationEntry[] {
    return this.#entries;
  }

  /** Forgets everything, before the agent replays a loaded conversation. */
  clear(): void {
    this.#entries.length = 0;
    this.#tools.clear();
  }

  apply(update: SessionUpdate): ConversationChange {
    return this.#trimmed(this.#changed(update));
  }

  /** A message the daemon sent the agent itself; the agent does not echo a prompt back as `user_message_chunk`. */
  said(text: string): ConversationChange {
    const entry: ConversationEntry = { id: this.#id("user"), kind: "user", text: cut(text) };
    this.#entries.push(entry);
    return this.#trimmed([entry]);
  }

  #changed(update: SessionUpdate): ConversationEntry[] {
    switch (update.sessionUpdate) {
      case "user_message_chunk":
        return this.#text("user", contentText(update.content));
      case "agent_message_chunk":
        return this.#text("agent", contentText(update.content));
      case "tool_call":
      case "tool_call_update":
        return [this.#tool(update)];
      case "session_info_update":
        return [];
    }
  }

  /** Drops the oldest entries beyond the budget; then every view gets the whole conversation again. */
  #trimmed(entries: ConversationEntry[]): ConversationChange {
    let size = this.#entries.reduce((sum, e) => sum + entrySize(e), 0);
    let dropped = false;
    while (this.#entries.length > 1 && (this.#entries.length > ENTRIES_MAX || size > CONVERSATION_CHARS_MAX)) {
      const oldest = this.#entries.shift();
      if (oldest === undefined) break;
      size -= entrySize(oldest);
      dropped = true;
      for (const [id, tool] of this.#tools) if (tool === oldest) this.#tools.delete(id);
    }
    return dropped ? { entries: this.#entries, reset: true } : { entries, reset: false };
  }

  #text(kind: "user" | "agent", text: string | undefined): ConversationEntry[] {
    if (text === undefined || text === "") return [];
    const last = this.#entries.at(-1);
    if (last?.kind === kind) {
      last.text = cut(last.text + text);
      return [last];
    }
    const entry: ConversationEntry = { id: this.#id(kind), kind, text: cut(text) };
    this.#entries.push(entry);
    return [entry];
  }

  #tool(update: ToolUpdate): ToolEntry {
    // Copilot CLI numbers tool calls per process (`call_1_0`), so a loaded conversation's new call can reuse an id.
    const known = update.sessionUpdate === "tool_call_update" ? this.#tools.get(update.toolCallId) : undefined;
    const detail = toolCallLines(update);
    if (known) {
      if (update.title !== undefined) known.title = update.title.slice(0, TOOL_TITLE_MAX);
      if (update.kind !== undefined) known.tool = update.kind.slice(0, TOOL_KIND_MAX);
      if (update.status !== undefined) known.status = update.status;
      if (detail.length > 0) known.detail = detail;
      return known;
    }
    const entry: ToolEntry = {
      id: this.#id("tool"),
      kind: "tool",
      title: (update.title ?? "Tool").slice(0, TOOL_TITLE_MAX),
      tool: (update.kind ?? "other").slice(0, TOOL_KIND_MAX),
      status: update.status ?? "pending",
      detail,
    };
    this.#tools.set(update.toolCallId, entry);
    this.#entries.push(entry);
    return entry;
  }

  #id(kind: string): string {
    return `${kind}-${this.#nextId++}`;
  }
}

/** What a tool call does or did, as lines, cut at 400 lines and 64 Ki characters: its diffs and text, the command it runs, the diff it asks to apply, or why it failed. */
export function toolCallLines(update: Pick<ToolUpdate, "content" | "rawInput" | "rawOutput" | "status">): string[] {
  const lines = [
    ...(update.content ?? []).flatMap(contentLines),
    ...commandLines(update.rawInput),
    ...rawDiffLines(update.rawInput),
    ...(update.status === "failed" ? failureLines(update.rawOutput) : []),
  ];
  const kept: string[] = [];
  let chars = 0;
  for (const line of lines.slice(0, DETAIL_LINES_MAX)) {
    if (chars + line.length > DETAIL_CHARS_MAX) {
      kept.push(line.slice(0, DETAIL_CHARS_MAX - chars));
      break;
    }
    kept.push(line);
    chars += line.length;
  }
  return kept;
}

function entrySize(entry: ConversationEntry): number {
  return entry.kind === "tool" ? entry.title.length + entry.detail.reduce((sum, line) => sum + line.length, 0) : entry.text.length;
}

function contentLines(content: ToolCallContent): string[] {
  if (content.type === "diff" && "path" in content && "newText" in content) {
    const removed = typeof content.oldText === "string" && content.oldText !== "" ? content.oldText.split("\n") : [];
    return [
      content.path,
      ...removed.map((l) => `- ${l}`),
      ...String(content.newText)
        .split("\n")
        .map((l) => `+ ${l}`),
    ];
  }
  if (content.type === "content" && "content" in content) {
    const text = contentText(content.content);
    return text === undefined ? [] : text.split("\n");
  }
  return [];
}

/** A shell tool's command (`rawInput.command`), the one input the user needs to see before allowing it. */
function commandLines(rawInput: unknown): string[] {
  if (typeof rawInput !== "object" || rawInput === null || !("command" in rawInput)) return [];
  const { command } = rawInput;
  return typeof command === "string" ? [`$ ${command}`] : [];
}

/** The diff an approval of a file edit carries in `rawInput.diff`, where Copilot CLI sends no `diff` content. */
function rawDiffLines(rawInput: unknown): string[] {
  if (typeof rawInput !== "object" || rawInput === null || !("diff" in rawInput)) return [];
  const { diff } = rawInput;
  return typeof diff === "string" ? diff.replace(/^\n+/, "").replace(/\n$/, "").split("\n") : [];
}

function failureLines(rawOutput: unknown): string[] {
  if (typeof rawOutput !== "object" || rawOutput === null || !("message" in rawOutput)) return [];
  const { message } = rawOutput;
  return typeof message === "string" ? message.split("\n") : [];
}

function cut(text: string): string {
  return text.length > CONVERSATION_TEXT_MAX ? text.slice(text.length - CONVERSATION_TEXT_MAX) : text;
}
