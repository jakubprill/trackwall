import { MCP_SERVER_NAME, mcpTools } from "@trackwall/protocol";

/**
 * The prompt the daemon types into a session when something waits for it (ADR-62, ADR-68): fixed sentences on one line,
 * without anything the Copilot CLI input box treats specially, each naming the tool that returns what waits. The text
 * itself (the user's review, another agent's message, an update) comes from the tool, never as keys.
 */

const SERVER = `(the ${MCP_SERVER_NAME} MCP server)`;
const REVIEW = `The user sent a review of your changes in Trackwall: call ${mcpTools.getReviewComments.name} ${SERVER} and address every comment.`;
const MESSAGES = `The session that proposed your task sent you a message in Trackwall: call ${mcpTools.getMessages.name} ${SERVER} and follow it as an update of your task.`;
const UPDATES = `There is news about the work you delegated in Trackwall: call ${mcpTools.getUpdates.name} ${SERVER} and act on it.`;

/** What waits unread for one session. */
export interface Unread {
  reviewComments: number;
  messages: number;
  updates: number;
}

/** The prompt for what waits, or `undefined` when nothing does. */
export function inboxPrompt({ reviewComments, messages, updates }: Unread): string | undefined {
  const parts = [reviewComments > 0 && REVIEW, messages > 0 && MESSAGES, updates > 0 && UPDATES].filter((part) => part !== false);
  return parts.length > 0 ? parts.join(" ") : undefined;
}
