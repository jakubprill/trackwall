import { z } from "zod";
import { FollowedStateFile } from "../../infra/state-file.ts";
import { type MiseTrustNotices, StoredTrustNotices } from "./mise-trust-notices.ts";
import { type Restored, StoredCoordination, type TaskCoordination } from "./task-coordination.ts";
import { StoredProposals, type TaskProposals } from "./task-proposals.ts";
import { StoredReviews, type TaskReviews } from "./task-reviews.ts";

/**
 * The agent queues (ADR-115, §4.4): what waits in the `agents` module for the user or an agent, kept in a file of the
 * state directory so that a daemon restart does not lose it. The next daemon resumes the sessions (ADR-95), so the
 * proposals they made, the reviews and messages for their tasks, the updates for the supervisor and the main sessions
 * and the mise trust notices (ADR-92) still have someone to reach. The file follows every change while the daemon
 * works and stops following once the daemon stops, so the ends of the sessions its stop causes do not reach it as
 * updates.
 */

export const AgentQueues = z.object({
  proposals: StoredProposals,
  reviews: StoredReviews,
  coordination: StoredCoordination,
  /** Not in a file of a Trackwall before the notices were kept, which then restores none. */
  trustNotices: StoredTrustNotices.default([]),
});
export type AgentQueues = z.infer<typeof AgentQueues>;

/** The queues of the `agents` module the file keeps. */
interface Queues {
  proposals: TaskProposals;
  reviews: TaskReviews;
  coordination: TaskCoordination;
  trustNotices: MiseTrustNotices;
}

/** What of the previous daemon is still there after its restart. */
export interface StillThere extends Restored {
  /** Whether a folder a waiting repo removal names is still there. */
  hasFolder(dir: string): boolean;
}

export class AgentQueuesFile {
  readonly #file: FollowedStateFile<AgentQueues>;
  readonly #queues: Queues;

  constructor(path: string, log: (msg: string) => void, queues: Queues) {
    this.#file = new FollowedStateFile(path, AgentQueues, {
      broken: (problem, aside) => log(`${path}: ${problem}; file moved to ${aside}, the queues start empty`),
      log,
    });
    this.#queues = queues;
  }

  /** The queues the previous daemon left, as far as they still have someone to reach; a missing or broken file leaves them empty. */
  restore(still: StillThere): void {
    const stored = this.#file.read();
    if (stored === undefined) return;
    this.#queues.proposals.restore(stored.proposals, still);
    this.#queues.reviews.restore(stored.reviews, still.hasTask);
    this.#queues.coordination.restore(stored.coordination, still);
    this.#queues.trustNotices.restore(stored.trustNotices, still);
  }

  /** The queues as they are now; a failed write goes to the log and is tried again at the next change. */
  follow(): void {
    const { proposals, reviews, coordination, trustNotices } = this.#queues;
    this.#file.follow({
      proposals: proposals.stored(),
      reviews: reviews.stored(),
      coordination: coordination.stored(),
      trustNotices: trustNotices.stored(),
    });
  }

  /** The daemon stops: the file keeps the queues of this moment for the next daemon. */
  stopFollowing(): void {
    this.#file.stopFollowing();
  }
}
