import type { ConversationEntry, ConversationServerMessage, SessionView, ToolCallStatus } from "@trackwall/protocol";
import type { StatusTone } from "./repo-status.ts";

/**
 * The conversation view of a session (ADR-107): the entries the daemon sends on the conversation socket, how a tool call
 * reads, what Enter in the message box does, and in which view the user starts the supervisor.
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

/** A tool call's state as `StatusLabel` shows it; one only asked for has no tone, since its approval says the rest. */
export const TOOL_STATUS: Record<ToolCallStatus, { label: string; tone?: StatusTone }> = {
  pending: { label: "asked" },
  in_progress: { label: "running", tone: "warning" },
  completed: { label: "done", tone: "ok" },
  failed: { label: "failed", tone: "error" },
};

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
