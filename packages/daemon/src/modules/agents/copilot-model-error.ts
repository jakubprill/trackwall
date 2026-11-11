import { z } from "zod";
import { jsonOf } from "./json.ts";

/**
 * The event Copilot CLI appends to a conversation's event log when a model call fails (ADR-242), `session.error` with
 * `errorType: "query"`: the provider refused the request, or, since Copilot CLI 1.0.109, the account does not offer the
 * session's model (`Execution failed: Model "…" is not available.`). Other error types (an MCP server, a hook) are not
 * the model's. Like the usage receipt, the format is Copilot CLI's own and undocumented; a contract test pins it.
 */

/** The event's type; a line without this text is not parsed at all, since tool results can make lines long. */
const SESSION_ERROR = "session.error";

/** The error type of a failed model call. */
const QUERY_ERROR = "query";

const ModelErrorLine = jsonOf(
  z.object({
    type: z.literal(SESSION_ERROR),
    data: z.object({ errorType: z.literal(QUERY_ERROR), message: z.string().min(1) }),
  }),
);

/** The longest message kept: Copilot CLI passes a provider's message on, and a provider may answer with a page. */
const MESSAGE_MAX = 500;

/** The message of a failed model call, from an event log's line; `undefined` for any other line. */
export function modelErrorOf(line: string): string | undefined {
  if (!line.includes(SESSION_ERROR)) return undefined;
  const parsed = ModelErrorLine.safeParse(line);
  if (!parsed.success) return undefined;
  const message = parsed.data.data.message.trim();
  return message.length > MESSAGE_MAX ? `${message.slice(0, MESSAGE_MAX)}…` : message;
}
