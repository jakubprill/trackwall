import type { Task, TaskProposal } from "@trackwall/protocol";
import { errorMessage } from "./api.ts";
import type { SessionSelection } from "./session-entries.ts";

/**
 * Decisions on the task proposals of one main session (ADR-55): starting several at once and where the Sessions view
 * goes after a decision. Without React, so that both the proposals panel and the grid tile use the same rules.
 */

/** A proposal to start, with the prompt the user may have edited. */
export interface ProposalStart {
  id: string;
  prompt: string;
}

/**
 * Starts the proposals one after another, in the given order: each creates a worktree and a Copilot CLI session, and
 * several git worktree commands at once on one repo would wait for each other's lock anyway. A failed start does not
 * stop the rest; the daemon keeps that proposal waiting, so the user can fix the prompt and try again.
 */
export async function startProposals(
  starts: readonly ProposalStart[],
  start: (start: ProposalStart) => Promise<Task>,
): Promise<{ started: Task[]; failed: Map<string, string> }> {
  const started: Task[] = [];
  const failed = new Map<string, string>();
  for (const item of starts) {
    try {
      started.push(await start(item));
    } catch (err) {
      failed.set(item.id, errorMessage(err));
    }
  }
  return { started, failed };
}

/**
 * What the Sessions view shows after a decision: the next proposal of the same session that still waits, so the user
 * goes through the plan without looking for it; when none is left, the first task that has just started, and after
 * rejecting the last one the session that proposed them (it waits for the answer), or the first entry without it.
 */
export function selectionAfterDecision(
  proposals: readonly TaskProposal[],
  decided: ReadonlySet<string>,
  proposer: string | null,
  started: readonly Task[],
): SessionSelection {
  const next = proposals.find((p) => !decided.has(p.id));
  if (next) return { kind: "proposal", id: next.id };
  const [first] = started;
  if (first) return { kind: "task", id: first.id };
  return proposer === null ? undefined : { kind: "session", id: proposer };
}
