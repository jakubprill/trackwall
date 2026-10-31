import { z } from "zod";
import { SessionId, TaskId } from "./agents.ts";
import { apiEndpoints } from "./api.ts";
import { RepoId } from "./workspace.ts";

/**
 * Contract of the `mcp-audit` module (ADR-152): every MCP tool call the daemon answered, with who called, the
 * identifier arguments the tool's contract names (`auditArgs` in `mcpTools`) and how it ended, kept on this computer
 * for the person who wants to see what agents did through Trackwall. Free text (a prompt, a body, headers, a search
 * pattern) never goes in. Every action is `POST /api/mcp-audit/<action>`.
 */

/** The most calls the audit keeps and returns; the oldest go first. */
export const MCP_AUDIT_MAX_CALLS = 500;
/** The longest argument value kept, as JSON; an identifier is far shorter. */
export const MCP_AUDIT_MAX_ARG_CHARS = 200;
/** The longest error text kept, the start of what the agent read. */
export const MCP_AUDIT_MAX_ERROR_CHARS = 300;

/**
 * The Trackwall session that called, as it was at the call, so the entry still says where it worked after the session
 * is gone. `null` in `McpCall.caller` is an agent outside Trackwall, with the daemon token.
 */
export const McpCaller = z.object({
  session: SessionId,
  /** `null`: the session works in the projects folder (the supervisor or a free session). */
  repo: RepoId.nullable(),
  task: TaskId.nullable(),
  supervisor: z.boolean(),
});
export type McpCaller = z.infer<typeof McpCaller>;

/** What the tool may do, from its contract: read Trackwall's state, write text for a human or an agent, or run or stop repo code. */
export const McpCallEffect = z.enum(["read", "write", "destructive"]);
export type McpCallEffect = z.infer<typeof McpCallEffect>;

export const McpCallOutcome = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ok") }),
  /** `code` and the start of the text the agent got (`not_found: …`, `internal: daemon error`). */
  z.object({ kind: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type McpCallOutcome = z.infer<typeof McpCallOutcome>;

/** One answered tool call. */
export const McpCall = z.object({
  /** ISO 8601, when the call came. */
  at: z.string(),
  tool: z.string(),
  effect: McpCallEffect,
  caller: McpCaller.nullable(),
  /** The identifier arguments the tool's contract names, as the tool read them; `null` when they failed its schema. */
  args: z.record(z.string(), z.unknown()).nullable(),
  outcome: McpCallOutcome,
  durationMs: z.number().int().nonnegative(),
});
export type McpCall = z.infer<typeof McpCall>;

/** Newest first. */
export const McpCallList = z.object({ calls: z.array(McpCall) });
export type McpCallList = z.infer<typeof McpCallList>;

/** The audit's revision for `/ws` (`mcp.calls.changed`): it grows with every recorded call. */
export const McpAuditRevision = z.object({ revision: z.number().int().nonnegative() });
export type McpAuditRevision = z.infer<typeof McpAuditRevision>;

const endpoint = apiEndpoints("mcp-audit");

export const mcpAuditApi = {
  /** The recorded calls, newest first; with `task`, only those of that task's sessions. */
  calls: endpoint("calls", z.object({ task: TaskId.optional() }).strict(), McpCallList),
};
