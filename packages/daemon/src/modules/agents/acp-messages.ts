import { z } from "zod";

/**
 * The parts of the Agent Client Protocol the daemon reads from `copilot --acp` (ADR-107), as Copilot CLI 1.0.105 sends
 * them (`contract/acp-session.contract.ts`). Fields the daemon does not use are left out, and unknown ones are kept
 * out by zod, so a newer Copilot CLI that adds fields still parses.
 */

/** The ACP version the daemon speaks. */
export const ACP_PROTOCOL_VERSION = 1;

export const InitializeResult = z.object({
  protocolVersion: z.number(),
  agentCapabilities: z.object({ loadSession: z.boolean().optional() }).optional(),
});

/**
 * Copilot CLI's id of a conversation (a UUID today). It goes back to Copilot CLI as `--resume=<id>` and in
 * `session/load`, so only characters an id needs, never a path or a control character.
 */
export const ConversationId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

export const NewSessionResult = z.object({ sessionId: ConversationId });

export const PromptResult = z.object({ stopReason: z.string() });

const TextContent = z.object({ type: z.literal("text"), text: z.string() });
/** A block of content; the daemon shows only text. */
const ContentBlock = z.union([TextContent, z.object({ type: z.string() })]);

/** What a tool call shows: text, a diff of a file, or a terminal the daemon does not read. */
const ToolCallContent = z.union([
  z.object({ type: z.literal("content"), content: ContentBlock }),
  z.object({ type: z.literal("diff"), path: z.string(), oldText: z.string().nullish(), newText: z.string() }),
  z.object({ type: z.string() }),
]);
export type ToolCallContent = z.infer<typeof ToolCallContent>;

const ToolCallStatus = z.enum(["pending", "in_progress", "completed", "failed"]);

const ToolCallFields = {
  toolCallId: z.string().min(1).max(128),
  title: z.string().optional(),
  kind: z.string().optional(),
  status: ToolCallStatus.optional(),
  content: z.array(ToolCallContent).optional(),
  rawInput: z.unknown().optional(),
  rawOutput: z.unknown().optional(),
};

export const SessionUpdate = z.discriminatedUnion("sessionUpdate", [
  z.object({ sessionUpdate: z.literal("user_message_chunk"), content: ContentBlock }),
  z.object({ sessionUpdate: z.literal("agent_message_chunk"), content: ContentBlock }),
  z.object({ sessionUpdate: z.literal("tool_call"), ...ToolCallFields }),
  z.object({ sessionUpdate: z.literal("tool_call_update"), ...ToolCallFields }),
  z.object({ sessionUpdate: z.literal("session_info_update"), title: z.string().nullish() }),
]);
export type SessionUpdate = z.infer<typeof SessionUpdate>;

/** `session/update`: the update is parsed separately, so a kind the daemon does not know is skipped, not an error. */
export const SessionUpdateParams = z.object({ sessionId: z.string(), update: z.object({ sessionUpdate: z.string() }).loose() });

export const PermissionOption = z.object({
  optionId: z.string().min(1).max(128),
  /** `allow_once`, `allow_always`, `reject_once`, `reject_always`. */
  kind: z.string(),
  name: z.string(),
});
export type PermissionOption = z.infer<typeof PermissionOption>;

export const RequestPermissionParams = z.object({
  sessionId: z.string(),
  toolCall: z.object(ToolCallFields),
  options: z.array(PermissionOption).min(1).max(9),
});
export type RequestPermissionParams = z.infer<typeof RequestPermissionParams>;

/** The answer to `session/request_permission`: an option, or `cancelled` when the turn was stopped. */
export type PermissionOutcome = { outcome: "selected"; optionId: string } | { outcome: "cancelled" };

/** The text of a content block; `undefined` for an image or anything else that is not text. */
export function contentText(block: z.infer<typeof ContentBlock>): string | undefined {
  return "text" in block && block.type === "text" && typeof block.text === "string" ? block.text : undefined;
}
