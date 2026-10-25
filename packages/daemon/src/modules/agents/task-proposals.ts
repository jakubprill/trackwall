import { randomUUID } from "node:crypto";
import type { ProposedBy, TaskProposal } from "@trackwall/protocol";
import { DomainError } from "../../infra/errors.ts";

/**
 * Task proposals (ADR-39): tasks submitted with the MCP tool `propose_task` that wait for the user's decision in the
 * Sessions view. Only in daemon memory, like the sessions that submit them: after a restart the proposing session is
 * not alive anyway, so nobody waits for an answer. Rejected ones disappear from the list, but their identifiers stay, so
 * that a session waiting for the proposal gets `proposal_rejected` instead of `not_found`.
 * Since ADR-55 a rejection also keeps the user's reason for that session.
 */

/** This many proposals can wait at once: a session in a loop does not flood the list, and a human would not review more anyway. */
export const MAX_PENDING_PROPOSALS = 20;
/** This many recent rejections the daemon remembers for waiting sessions. */
const REMEMBERED_REJECTIONS = 100;

export class TaskProposals {
  /** Newest first. */
  #pending: TaskProposal[] = [];
  /**
   * Approved ones whose task is still being created: they stay on the list, so that the panel in the UI does not disappear
   * during approval (with an error and an edited prompt), but nobody approves or rejects them a second time.
   */
  readonly #approving = new Set<string>();
  /** Rejected id to the user's reason (`null` without one), oldest first; the oldest drop out after `REMEMBERED_REJECTIONS`. */
  readonly #rejected = new Map<string, string | null>();

  list(): TaskProposal[] {
    return [...this.#pending];
  }

  add(proposal: { repo: string; title: string; prompt: string; proposedBy: ProposedBy }): TaskProposal {
    if (this.#pending.length >= MAX_PENDING_PROPOSALS) {
      throw new DomainError(
        "bad_request",
        `${MAX_PENDING_PROPOSALS} task proposals are already waiting for the user; wait for their decision`,
      );
    }
    const added: TaskProposal = { id: randomUUID(), ...proposal, createdAt: new Date().toISOString() };
    this.#pending = [added, ...this.#pending];
    return added;
  }

  /** A proposal waiting for a decision (not one being approved), or `undefined`. */
  find(id: string): TaskProposal | undefined {
    return this.#approving.has(id) ? undefined : this.#pending.find((p) => p.id === id);
  }

  /** A waiting proposal (`not_found` when it is missing, because the user has already decided). */
  get(id: string): TaskProposal {
    const proposal = this.find(id);
    if (!proposal) throw new DomainError("not_found", `no task proposal ${id} is waiting for a decision`);
    return proposal;
  }

  /** A proposal approved while its task is being created, or `undefined`. */
  approving(id: string): TaskProposal | undefined {
    return this.#approving.has(id) ? this.#pending.find((p) => p.id === id) : undefined;
  }

  /** Takes a waiting proposal for approval; a second `take` or `reject` is `not_found` while it lasts. */
  take(id: string): TaskProposal {
    const proposal = this.get(id);
    this.#approving.add(id);
    return proposal;
  }

  /**
   * The end of approval: with `restore` the proposal waits again (the task was not created), without it it disappears,
   * because it is a task now.
   */
  release(id: string, restore: boolean): void {
    this.#approving.delete(id);
    if (!restore) this.#pending = this.#pending.filter((p) => p.id !== id);
  }

  reject(id: string, reason: string | null): void {
    this.get(id);
    this.#pending = this.#pending.filter((p) => p.id !== id);
    this.#rejected.set(id, reason);
    for (const old of this.#rejected.keys()) {
      if (this.#rejected.size <= REMEMBERED_REJECTIONS) break;
      this.#rejected.delete(old);
    }
  }

  /** How the user rejected the proposal, or `undefined` when it was not rejected (or long enough ago to be forgotten). */
  rejection(id: string): { reason: string | null } | undefined {
    return this.#rejected.has(id) ? { reason: this.#rejected.get(id) ?? null } : undefined;
  }
}
