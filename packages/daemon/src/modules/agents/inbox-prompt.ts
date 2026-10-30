import { MCP_SERVER_NAME, mcpTools } from "@trackwall/protocol";

/**
 * The prompt the daemon types into a session when something waits for it (ADR-62, ADR-68): fixed sentences on one line,
 * without anything the Copilot CLI input box treats specially, each naming the tool that returns what waits. The text
 * itself (the user's review, another agent's message, an update) comes from the tool, never as keys; a trust notice
 * (ADR-92) has no text beyond its fixed sentence.
 */

const SERVER = `(the ${MCP_SERVER_NAME} MCP server)`;
const REVIEW = `The user sent a review of your changes in Trackwall: call ${mcpTools.getReviewComments.name} ${SERVER} and address every comment.`;
const MESSAGES = `The session that proposed your task sent you a message in Trackwall: call ${mcpTools.getMessages.name} ${SERVER} and follow it as an update of your task.`;
const HANDOFF = `The task that handed you your work has new commits in Trackwall: call ${mcpTools.getHandoff.name} ${SERVER} and check whether they change what you build on.`;
const UPDATES = `There is news about the work you delegated in Trackwall: call ${mcpTools.getUpdates.name} ${SERVER} and act on it.`;
/** The one part with nothing to read: that the user trusted a mise config is the whole news (ADR-92). */
const TRUST_NOTICE = `The user trusted the mise config that refused your last ${mcpTools.runMiseTask.name}, ${mcpTools.verifyTask.name} or ${mcpTools.startService.name} in Trackwall: run it again if you still need it.`;

/** What waits unread for one session. */
export interface Unread {
  reviewComments: number;
  messages: number;
  /** The branch of the task that handed this session's task its work moved since it read it (ADR-144). */
  handoffMoved: boolean;
  updates: number;
  /** The user trusted the mise config a run of the session was refused for (ADR-92). */
  trustNotice: boolean;
}

/** The prompt for what waits, or `undefined` when nothing does. */
export function inboxPrompt({ reviewComments, messages, handoffMoved, updates, trustNotice }: Unread): string | undefined {
  const parts = [
    reviewComments > 0 && REVIEW,
    messages > 0 && MESSAGES,
    handoffMoved && HANDOFF,
    updates > 0 && UPDATES,
    trustNotice && TRUST_NOTICE,
  ].filter((part) => part !== false);
  return parts.length > 0 ? parts.join(" ") : undefined;
}
