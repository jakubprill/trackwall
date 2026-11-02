import type { ConversationEntry, ConversationServerMessage, Session, SessionView, ToolCallStatus } from "@trackwall/protocol";
import type { StatusTone } from "./repo-status.ts";

/**
 * The conversation view of a session (ADR-107): the entries the daemon sends on the conversation socket, how a tool call
 * reads, what the line above the message box says, what Enter in it does, and in which view the user starts the supervisor.
 */

/** The entries after a frame: after `reset` only its entries, otherwise each one replaces the entry with its id or comes last. */
export function withEntries(entries: readonly ConversationEntry[], message: ConversationServerMessage): ConversationEntry[] {
  const next = message.reset ? [] : [...entries];
  for (const entry of message.entries) {
    const at = next.findIndex((e) => e.id === entry.id);
    if (at >= 0) next[at] = entry;
    else next.push(entry);
  }
  return next;
}

type UserEntry = Extract<ConversationEntry, { kind: "user" }>;
type AgentStep = Exclude<ConversationEntry, { kind: "user" }>;

/** What the view draws: each user message on its own, and the agent's answers and tool calls between two of them as one turn. */
export type ConversationTurn = { kind: "user"; entry: UserEntry } | { kind: "agent"; id: string; steps: AgentStep[] };

/** The entries as turns, so the agent's turn reads as one block under one name instead of loose lines. */
export function conversationTurns(entries: readonly ConversationEntry[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const entry of entries) {
    if (entry.kind === "user") {
      turns.push({ kind: "user", entry });
      continue;
    }
    const last = turns.at(-1);
    if (last?.kind === "agent") last.steps.push(entry);
    else turns.push({ kind: "agent", id: entry.id, steps: [entry] });
  }
  return turns;
}

/** A tool call's state as `StatusLabel` shows it; one only asked for has no tone, since its approval says the rest. */
export const TOOL_STATUS: Record<ToolCallStatus, { label: string; tone?: StatusTone }> = {
  pending: { label: "asked" },
  in_progress: { label: "running", tone: "warning" },
  completed: { label: "done", tone: "ok" },
  failed: { label: "failed", tone: "error" },
};

/** How many lines of a tool call's change the conversation view shows; the "Changes" view has all of them. */
export const PATCH_SHOWN_LINES = 400;

/** The line under a tool call's title: the command of a shell tool, otherwise the files it works on. */
export function toolSubtitle(tool: Pick<Extract<ConversationEntry, { kind: "tool" }>, "tool" | "detail" | "files">): string | undefined {
  const command = tool.tool === "execute" ? tool.detail.find((line) => line.startsWith("$ ")) : undefined;
  return command ?? (tool.files.length > 0 ? tool.files.join(", ") : undefined);
}

/**
 * Whose turn it is, in the line above the message box of a running session: the conversation itself shows nothing
 * while the agent thinks, so without it the user cannot tell a working agent from one waiting for them.
 */
export function conversationStatus(session: Pick<Session, "state" | "stuck">): { tone: StatusTone; label: string } {
  switch (session.state?.state) {
    case undefined:
      return { tone: "warning", label: "Starting the session…" };
    case "Working":
      return session.stuck === null
        ? { tone: "ok", label: "The agent is working…" }
        : { tone: "warning", label: "The agent may be stuck: nothing new from it for a while" };
    case "Approval":
    case "Plan":
      return { tone: "warning", label: "The agent asks for your approval" };
    case "Error":
      return { tone: "error", label: "The last turn failed; write to the agent to go on" };
    case "Stale":
      return { tone: "error", label: "The agent is not responding" };
    case "Input":
    case "Done":
      return { tone: "ok", label: "Your turn: the agent waits for your message" };
  }
}

/** Enter sends the message; Shift+Enter is a new line, and Enter while an input method composes a word belongs to it. */
export function sendsMessage(event: Pick<KeyboardEvent, "key" | "shiftKey" | "isComposing">): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing;
}

/**
 * The view a new supervisor starts in, a convenience of this browser profile kept in `localStorage` like the panel's
 * layout. The terminal until the user picks the conversation view; a storage failure reads as the terminal, and a
 * write that fails is forgotten.
 */
const VIEW_KEY = "trackwall.supervisor.view";

export function readSupervisorView(storage: () => Pick<Storage, "getItem">): SessionView {
  try {
    return storage().getItem(VIEW_KEY) === "conversation" ? "conversation" : "terminal";
  } catch {
    return "terminal";
  }
}

export function saveSupervisorView(storage: () => Pick<Storage, "setItem">, view: SessionView): void {
  try {
    storage().setItem(VIEW_KEY, view);
  } catch {
    // The choice holds in this window; only the next start of the app does not remember it.
  }
}
