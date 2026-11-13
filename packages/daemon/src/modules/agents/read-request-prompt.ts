import { MCP_SERVER_NAME, mcpTools } from "@trackwall/protocol";

/**
 * The prompt the daemon types into a session when something waits for it (ADR-62, ADR-68, ADR-197): fixed sentences on one line,
 * without anything the Copilot CLI input box treats specially, each naming the tool that returns what waits. The text
 * itself (the user's review, another agent's message, an update) comes from the tool, never as keys; a trust notice
 * (ADR-92), an undone round (ADR-168) and a refresh from the base branch (ADR-244) have no text beyond their fixed sentence.
 */

const SERVER = `(the ${MCP_SERVER_NAME} MCP server)`;
const REVIEW = `The user sent a review of your changes in Trackwall: call ${mcpTools.getReviewComments.name} ${SERVER} and address every comment.`;
const PIPELINE_FIX = `The user asks you to fix the failed pipeline of your merge request: call ${mcpTools.getReviewComments.name} ${SERVER} for the end of the failed jobs' logs.`;
const MESSAGES = `The session that proposed your task, or the supervisor the user handed it to, sent you a message in Trackwall: call ${mcpTools.getMessages.name} ${SERVER} and follow it as an update of your task.`;
const HANDOFF = `The task that handed you your work has new commits in Trackwall: call ${mcpTools.getHandoff.name} ${SERVER} and check whether they change what you build on.`;
const UPDATES = `There is news about the work you delegated in Trackwall: call ${mcpTools.getUpdates.name} ${SERVER} and act on it.`;
/** Nothing to read either: the worktree itself shows what is left (ADR-168). */
const ROUND_UNDONE =
  "The user undid your last round of changes in Trackwall: the worktree and the task branch are back where they were before that round, so check them with git status and git log before you go on, and do not redo the undone changes unless the user asks.";
/** Nothing to read either: the merge commit on the task branch says what came in (ADR-244). */
const REFRESHED =
  "The user merged the newest commits of your task's base branch into your task branch in Trackwall: files in the worktree may have changed, so check git log and read again the files you work on before you go on.";
/** The one part with nothing to read: that the user trusted a mise config is the whole news (ADR-92). */
const TRUST_NOTICE = `The user trusted the mise config that refused your last ${mcpTools.runMiseTask.name}, ${mcpTools.verifyTask.name} or ${mcpTools.startService.name} in Trackwall: run it again if you still need it.`;

/** What waits unread for one session. */
export interface Unread {
  reviewComments: number;
  /** The user asked the task's agent to fix its merge request's failed pipeline (ADR-197). */
  pipelineFix: boolean;
  messages: number;
  /** The branch of the task that handed this session's task its work moved since it read it (ADR-144). */
  handoffMoved: boolean;
  /** The user undid a round of the session's task, and the agent has not been told (ADR-168). */
  roundUndone: boolean;
  /** The user refreshed the session's task from its base branch, and the agent has not been told (ADR-244). */
  refreshed: boolean;
  updates: number;
  /** The user trusted the mise config a run of the session was refused for (ADR-92). */
  trustNotice: boolean;
}

/** The prompt for what waits, or `undefined` when nothing does. */
export function readRequestPrompt({
  reviewComments,
  pipelineFix,
  messages,
  handoffMoved,
  roundUndone,
  refreshed,
  updates,
  trustNotice,
}: Unread): string | undefined {
  const parts = [
    // First: what the agent reads next may refer to the changes that are gone.
    roundUndone && ROUND_UNDONE,
    refreshed && REFRESHED,
    reviewComments > 0 && REVIEW,
    pipelineFix && PIPELINE_FIX,
    messages > 0 && MESSAGES,
    handoffMoved && HANDOFF,
    updates > 0 && UPDATES,
    trustNotice && TRUST_NOTICE,
  ].filter((part) => part !== false);
  return parts.length > 0 ? parts.join(" ") : undefined;
}
