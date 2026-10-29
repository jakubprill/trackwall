import { z } from "zod";
import { FollowedStateFile } from "./state-file.ts";
import { StoredCoordination, type TaskCoordination } from "./task-coordination.ts";
import { StoredProposals, type TaskProposals } from "./task-proposals.ts";
import { StoredReviews, type TaskReviews } from "./task-reviews.ts";

/**
 * The agent queues (ADR-115, §4.4): what waits in the `agents` module for the user or an agent, kept in a file of the
 * state directory so that a daemon restart does not lose it. The next daemon resumes the sessions (ADR-95), so the
 * proposals they made, the reviews and messages for their tasks and the updates for the supervisor and the main
 * sessions still have someone to reach. The file follows every change while the daemon works and stops following once
 * the daemon stops, so the ends of the sessions its stop causes do not reach it as updates.
 */

export const AgentQueues = z.object({
  proposals: StoredProposals,
  reviews: StoredReviews,
  coordination: StoredCoordination,
});
export type AgentQueues = z.infer<typeof AgentQueues>;

/** The queues of the `agents` module the file keeps. */
interface Queues {
  proposals: TaskProposals;
  reviews: TaskReviews;
  coordination: TaskCoordination;
}

/** What of the previous daemon is still there after its restart. */
export interface StillThere {
  hasTask(task: string): boolean;
  /** The sessions the next daemon resumes under the same id: the supervisor, free and main sessions. */
  hasSession: ReadonlySet<string>;
}

export class AgentQueuesFile {
  readonly #file: FollowedStateFile<AgentQueues>;
  readonly #queues: Queues;
  readonly #log: (msg: string) => void;

  constructor(path: string, log: (msg: string) => void, queues: Queues) {
    this.#file = new FollowedStateFile(path, AgentQueues, (problem, aside) =>
      log(`${path}: ${problem}; file moved to ${aside}, the queues start empty`),
    );
    this.#queues = queues;
    this.#log = log;
  }

  /** The queues the previous daemon left, as far as they still have someone to reach; a missing or broken file leaves them empty. */
  restore({ hasTask, hasSession }: StillThere): void {
    const stored = this.#file.read();
    if (stored === undefined) return;
    this.#queues.proposals.restore(stored.proposals, hasTask);
    this.#queues.reviews.restore(stored.reviews, hasTask);
    this.#queues.coordination.restore(stored.coordination, { hasTask, hasSession: (id) => hasSession.has(id) });
  }

  /** The queues as they are now; a failed write goes to the log and is tried again at the next change. */
  follow(): void {
    const { proposals, reviews, coordination } = this.#queues;
    try {
      this.#file.follow({ proposals: proposals.stored(), reviews: reviews.stored(), coordination: coordination.stored() });
    } catch (err) {
      this.#log(`writing the agent queues: ${String(err)}`);
    }
  }

  /** The daemon stops: the file keeps the queues of this moment for the next daemon. */
  stopFollowing(): void {
    this.#file.stopFollowing();
  }
}
