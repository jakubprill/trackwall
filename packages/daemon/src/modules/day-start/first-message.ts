import { mcpTools } from "@trackwall/protocol";

/**
 * The day start's first message to the new supervisor (ADR-70): read the day report, brief the user, propose little.
 * Trackwall's part is general; the user's `dayStart.prompt` from `workspace.yaml` follows it with what only the user
 * knows (an issue tracker query, a group on the repo host), so none of that is in the repo (ADR-7).
 */

/** At most this many task proposals per day start: more are noise the user has to reject one by one. */
const DAY_START_PROPOSALS = 3;

const TRACKWALL_PART = [
  `Start my day. Trackwall has just synced every repo; call ${mcpTools.getDayReport.name} for what changed since my previous day start.`,
  "Then brief me in a few short lines: what changed that matters, what waits for me (tasks that need me, repos the sync " +
    "could not update), and which tasks are stale or far behind their repo's default branch.",
  "If you have tools for the repo host or the issue tracker, check them too: a repo's remote is its project path on the " +
    "repo host, and a task's branch is the source branch of its merge request.",
  `Propose at most ${DAY_START_PROPOSALS} tasks with ${mcpTools.proposeTask.name}, only where the repo is clear; list the ` +
    "rest with a number each, so I can ask for the ones I want.",
].join(" ");

export function dayStartFirstMessage(userPart: string | null): string {
  return userPart === null ? TRACKWALL_PART : `${TRACKWALL_PART}\n\n${userPart}`;
}
