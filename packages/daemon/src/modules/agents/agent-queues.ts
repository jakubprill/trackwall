import { isAbsolute } from "node:path";
import { TaskId } from "@trackwall/protocol";
import { z } from "zod";
import { FollowedStateFile } from "./state-file.ts";
import { StoredCoordination } from "./task-coordination.ts";
import { StoredProposals } from "./task-proposals.ts";
import { StoredReviews } from "./task-reviews.ts";

/**
 * The agent queues (ADR-115, §4.4): what waits in the `agents` module for the user or an agent, kept in a file of the
 * state directory so that a daemon restart does not lose it. The next daemon resumes the sessions (ADR-95), so the
 * proposals they made, the reviews and messages for their tasks and the updates for the supervisor and the main
 * sessions still have someone to reach. The file follows every change while the daemon works and stops following once
 * the daemon stops, so the ends of the sessions its stop causes do not reach it as updates.
 */

export const AgentQueues = z.object({
  proposals: StoredProposals,
  /** The folder each waiting repo removal names (ADR-83). */
  removalDirs: z.record(TaskId, z.string().max(4096).refine(isAbsolute, "a repo folder must be a full path")),
  reviews: StoredReviews,
  coordination: StoredCoordination,
});
export type AgentQueues = z.infer<typeof AgentQueues>;

/** The file of the agent queues; a missing file means none, a broken one is moved aside and the queues start empty. */
export function agentQueuesFile(path: string, log: (msg: string) => void): FollowedStateFile<AgentQueues> {
  return new FollowedStateFile(path, AgentQueues, (problem, aside) =>
    log(`${path}: ${problem}; file moved to ${aside}, the queues start empty`),
  );
}
