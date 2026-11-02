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
/** What the agent thought on its way to an answer (the model's reasoning), shown folded. */
export const ThoughtEntry = z.object({ id: EntryId, kind: z.literal("thought"), text: EntryText });

/** Where a tool call is: asked for, running, done or failed (refused tools too). */
export const ToolCallStatus = z.enum(["pending", "in_progress", "completed", "failed"]);
export type ToolCallStatus = z.infer<typeof ToolCallStatus>;

export const TOOL_TITLE_MAX = 1000;
export const TOOL_KIND_MAX = 64;
/** The longest patch of a tool call the daemon keeps; a longer one is cut at the end, on a line. */
export const TOOL_PATCH_MAX = 64 * 1024;
/** The most files of a tool call, and the longest path of one. */
export const TOOL_FILES_MAX = 50;
export const TOOL_FILE_PATH_MAX = 4096;

/** A unified diff (`git diff`), empty when there is none, as a tool call and an approval carry it. */
export const ToolPatch = z.string().max(TOOL_PATCH_MAX);

/**
 * A tool the agent called: its title, what kind of tool, where it is, the files it reads or changes, lines of what it
 * did (its output, a command, an error), and the change it makes to files as a unified diff.
 */
export const ToolEntry = z.object({
  id: EntryId,
  kind: z.literal("tool"),
  title: z.string().max(TOOL_TITLE_MAX),
  /** ACP's tool kind (`read`, `edit`, `execute`, `search`, `other`, …), as Copilot CLI gives it. */
  tool: z.string().max(TOOL_KIND_MAX),
  status: ToolCallStatus,
  /** The files the tool works on, relative to the session's working directory when inside it. */
  files: z.array(z.string().max(TOOL_FILE_PATH_MAX)).max(TOOL_FILES_MAX).default([]),
  detail: z.array(z.string().max(CONVERSATION_TEXT_MAX)).max(2000),
  /** A daemon before the patch sent none. */
  patch: ToolPatch.default(""),
  /** The change was longer than `TOOL_PATCH_MAX` and `patch` is its beginning. */
  patchCut: z.boolean().default(false),
  /** A subagent the tool started: its type and what it was asked; `null` for any other tool. */
  subagent: z
    .object({ type: z.string().max(TOOL_KIND_MAX), prompt: EntryText })
    .nullable()
    .default(null),
});

export const ConversationEntry = z.discriminatedUnion("kind", [UserEntry, AgentEntry, ThoughtEntry, ToolEntry]);
export type ConversationEntry = z.infer<typeof ConversationEntry>;

/** Copilot CLI's id of a mode (a URL today). */
export const ConversationModeId = z.string().min(1).max(256);

/** One of the agent's modes (Agent, Plan, …): Copilot CLI's id, name and description. */
export const ConversationModeOption = z.object({ id: ConversationModeId, name: z.string().max(64), description: z.string().max(1000) });

/** The agent's mode: the one it works in, and the ones the user can switch to. */
export const ConversationMode = z.object({ current: ConversationModeId, options: z.array(ConversationModeOption).max(10) });
export type ConversationMode = z.infer<typeof ConversationMode>;

/** How much of the model's context window the conversation uses, in tokens. */
export const ContextUse = z.object({ used: z.number().int().nonnegative(), size: z.number().int().positive() });
export type ContextUse = z.infer<typeof ContextUse>;

/** A slash command the agent offers (`/compact`), with what it does and a hint at its argument (empty for none). */
export const SlashCommand = z.object({ name: z.string().min(1).max(64), description: z.string().max(1000), hint: z.string().max(200) });
export type SlashCommand = z.infer<typeof SlashCommand>;
export const SLASH_COMMANDS_MAX = 300;

/** A message the user wrote during a turn, which goes to the agent as the next prompt once the turn ends. */
export const WaitingMessage = z.object({ id: EntryId, text: EntryText });
export type WaitingMessage = z.infer<typeof WaitingMessage>;

/**
 * What the daemon sends on the conversation socket: `entries` that are new or changed, in order, after `reset` all of
 * them (the first frame, and after the conversation was loaded again), and every frame the user's messages that wait
 * for the turn to end, oldest first (none from a daemon before them). The agent's `mode`, its `context` use and its
 * slash `commands` come in the first frame and then only in a frame where they changed; `null` until the agent told.
 */
export const ConversationServerMessage = z.object({
  type: z.literal("entries"),
  reset: z.boolean(),
  entries: z.array(ConversationEntry),
  waiting: z.array(WaitingMessage).default([]),
  mode: ConversationMode.nullable().optional(),
  context: ContextUse.nullable().optional(),
  commands: z.array(SlashCommand).max(SLASH_COMMANDS_MAX).optional(),
});
export type ConversationServerMessage = z.infer<typeof ConversationServerMessage>;

/** What the UI sends on the conversation socket: whether the view is in front of the user (ADR-47). */
export const ConversationClientMessage = z.object({ type: z.literal("focus"), focused: z.boolean() }).strict();
export type ConversationClientMessage = z.infer<typeof ConversationClientMessage>;

/** The longest message the user can write to a session in the conversation view. */
export const SESSION_MESSAGE_MAX = 64 * 1024;
export const SessionMessage = z.string().trim().min(1).max(SESSION_MESSAGE_MAX);
