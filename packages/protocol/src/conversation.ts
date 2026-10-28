import { z } from "zod";

/**
 * The conversation view (ADR-107): a Copilot CLI session the daemon runs over the Agent Client Protocol (`copilot
 * --acp`) instead of in a terminal, which the UI shows as a list of conversation entries. The WebSocket
 * `/ws/conversation/<session>` (§5.2) sends the entries; what the user writes and the answers to approvals go through
 * the `agents` API.
 */

/**
 * How a session shows: `terminal`, Copilot CLI's own screen in a PTY (ADR-26), or `conversation`, Trackwall's
 * conversation view over ACP (ADR-107).
 */
export const SessionView = z.enum(["terminal", "conversation"]);
export type SessionView = z.infer<typeof SessionView>;

/** The longest text of one entry the daemon keeps; the start of a longer one is cut, not the end, which says the most. */
export const CONVERSATION_TEXT_MAX = 200_000;

const EntryId = z.string().min(1).max(128);
const EntryText = z.string().max(CONVERSATION_TEXT_MAX);

/** What the user wrote, or what the daemon sent for them (a review, task messages, updates). */
export const UserEntry = z.object({ id: EntryId, kind: z.literal("user"), text: EntryText });
/** The agent's answer, Markdown as the model wrote it. */
export const AgentEntry = z.object({ id: EntryId, kind: z.literal("agent"), text: EntryText });

/** Where a tool call is: asked for, running, done or failed (refused tools too). */
export const ToolCallStatus = z.enum(["pending", "in_progress", "completed", "failed"]);
export type ToolCallStatus = z.infer<typeof ToolCallStatus>;

export const TOOL_TITLE_MAX = 1000;
export const TOOL_KIND_MAX = 64;

/** A tool the agent called: its title, what kind of tool, where it is, and lines of what it did (a diff, a command, an error). */
export const ToolEntry = z.object({
  id: EntryId,
  kind: z.literal("tool"),
  title: z.string().max(TOOL_TITLE_MAX),
  /** ACP's tool kind (`read`, `edit`, `execute`, `search`, `other`, …), as Copilot CLI gives it. */
  tool: z.string().max(TOOL_KIND_MAX),
  status: ToolCallStatus,
  detail: z.array(z.string().max(CONVERSATION_TEXT_MAX)).max(2000),
});

export const ConversationEntry = z.discriminatedUnion("kind", [UserEntry, AgentEntry, ToolEntry]);
export type ConversationEntry = z.infer<typeof ConversationEntry>;

/**
 * What the daemon sends on the conversation socket: `entries` that are new or changed, in order, after `reset` all of
 * them (the first frame, and after the conversation was loaded again).
 */
export const ConversationServerMessage = z.object({
  type: z.literal("entries"),
  reset: z.boolean(),
  entries: z.array(ConversationEntry),
});
export type ConversationServerMessage = z.infer<typeof ConversationServerMessage>;

/** What the UI sends on the conversation socket: whether the view is in front of the user (ADR-47). */
export const ConversationClientMessage = z.object({ type: z.literal("focus"), focused: z.boolean() }).strict();
export type ConversationClientMessage = z.infer<typeof ConversationClientMessage>;

/** The longest message the user can write to a session in the conversation view. */
export const SESSION_MESSAGE_MAX = 64 * 1024;
export const SessionMessage = z.string().trim().min(1).max(SESSION_MESSAGE_MAX);
