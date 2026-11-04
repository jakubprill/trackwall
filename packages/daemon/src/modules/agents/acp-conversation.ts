import { type AttachmentLabel, CONVERSATION_TEXT_MAX, type ConversationEntry, TOOL_KIND_MAX, TOOL_TITLE_MAX } from "@trackwall/protocol";
import { contentText, type SessionUpdate } from "./acp-messages.ts";
import { toolCallFiles, toolCallLines, toolCallPatch, toolCallSubagent } from "./acp-tool-call.ts";

/**
 * The conversation of a session in the conversation view (ADR-107), built from ACP's `session/update` notifications:
 * message and thought chunks join into one entry until something else comes, and a tool call's updates change its
 * entry. `apply` returns the entries an update changed, which go to the conversation sockets as they are. Everything
 * the agent sends is cut to the protocol's limits, and the oldest entries go once the conversation outgrows its budget,
 * so one answer or a long session cannot fill the daemon's memory or a socket's first frame.
 */

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

type TextEntry = Extract<ConversationEntry, { text: string }>;

export class AcpConversation {
  /** The names of the session's working directory (`workingDirectoryNames`), which tool calls' files are shown relative to. */
  readonly #cwdNames: readonly string[];
  readonly #entries: ConversationEntry[] = [];
  readonly #tools = new Map<string, ToolEntry>();
  #nextId = 1;

  constructor(cwdNames: readonly string[]) {
    this.#cwdNames = cwdNames;
  }

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
  said(text: string, attachments: readonly AttachmentLabel[] = []): ConversationChange {
    const entry: ConversationEntry = { id: this.#id("user"), kind: "user", text: cut(text), attachments: [...attachments] };
    this.#entries.push(entry);
    return this.#trimmed([entry]);
  }

  #changed(update: SessionUpdate): ConversationEntry[] {
    switch (update.sessionUpdate) {
      case "user_message_chunk":
        return this.#text("user", contentText(update.content));
      case "agent_message_chunk":
        return this.#text("agent", contentText(update.content));
      case "agent_thought_chunk":
        return this.#text("thought", contentText(update.content));
      case "tool_call":
      case "tool_call_update":
        return [this.#tool(update)];
      // The session's title, mode, context use and commands are not entries (`acp-session-info.ts`).
      case "session_info_update":
      case "usage_update":
      case "config_option_update":
      case "available_commands_update":
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

  #text(kind: TextEntry["kind"], text: string | undefined): ConversationEntry[] {
    if (text === undefined || text === "") return [];
    const last = this.#entries.at(-1);
    if (last?.kind === kind) {
      last.text = cut(last.text + text);
      return [last];
    }
    const id = this.#id(kind);
    // A replayed message's attachments are not known: Copilot CLI replays only its text.
    const entry: ConversationEntry = kind === "user" ? { id, kind, text: cut(text), attachments: [] } : { id, kind, text: cut(text) };
    this.#entries.push(entry);
    return [entry];
  }

  #tool(update: ToolUpdate): ToolEntry {
    // Copilot CLI numbers tool calls per process (`call_1_0`), so a loaded conversation's new call can reuse an id.
    const known = update.sessionUpdate === "tool_call_update" ? this.#tools.get(update.toolCallId) : undefined;
    if (known) return this.#toolUpdated(known, update);
    const entry: ToolEntry = {
      id: this.#id("tool"),
      kind: "tool",
      title: (update.title ?? "Tool").slice(0, TOOL_TITLE_MAX),
      tool: (update.kind ?? "other").slice(0, TOOL_KIND_MAX),
      status: update.status ?? "pending",
      files: toolCallFiles(update, this.#cwdNames),
      detail: toolCallLines(update),
      ...patchFields(update),
      subagent: toolCallSubagent(update),
    };
    this.#tools.set(update.toolCallId, entry);
    this.#entries.push(entry);
    return entry;
  }

  /** An update changes only what it sends; Copilot CLI sends a tool's files and change again with its result. */
  #toolUpdated(known: ToolEntry, update: ToolUpdate): ToolEntry {
    const files = toolCallFiles(update, this.#cwdNames);
    const detail = toolCallLines(update);
    const change = patchFields(update);
    if (update.title !== undefined) known.title = update.title.slice(0, TOOL_TITLE_MAX);
    if (update.kind !== undefined) known.tool = update.kind.slice(0, TOOL_KIND_MAX);
    if (update.status !== undefined) known.status = update.status;
    if (files.length > 0) known.files = files;
    if (detail.length > 0) known.detail = detail;
    if (change.patch !== "") {
      known.patch = change.patch;
      known.patchCut = change.patchCut;
    }
    known.subagent = toolCallSubagent(update) ?? known.subagent;
    return known;
  }

  #id(kind: string): string {
    return `${kind}-${this.#nextId++}`;
  }
}

/** A tool call's change as its entry keeps it. */
function patchFields(update: ToolUpdate): Pick<ToolEntry, "patch" | "patchCut"> {
  const { patch, cut } = toolCallPatch(update);
  return { patch, patchCut: cut };
}

function entrySize(entry: ConversationEntry): number {
  if (entry.kind !== "tool") return entry.text.length;
  const sizes = [entry.title, entry.files.join(""), entry.detail.join(""), entry.patch, entry.subagent?.prompt ?? ""];
  return sizes.reduce((sum, text) => sum + text.length, 0);
}

function cut(text: string): string {
  return text.length > CONVERSATION_TEXT_MAX ? text.slice(text.length - CONVERSATION_TEXT_MAX) : text;
}
