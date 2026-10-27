import { isSupervisor, type ProposedBy, type Session } from "@trackwall/protocol";

/**
 * Who proposed a task, as the task's messages and updates see it (ADR-68): the proposing session, or, for the
 * supervisor's work, whichever supervisor runs now (`SUPERVISOR`), so a replaced supervisor's work still reaches the new
 * one, as the Sessions view keeps it under the Supervisor heading (ADR-58).
 */

/** The proposer key of the supervisor's work; session ids are UUIDs, so it never names a session. */
export const SUPERVISOR = "supervisor";

/** `ProposedBy` of a caller: a listed session, or `null` for an agent outside Trackwall. */
export function proposedByOf(caller: Session | null): ProposedBy {
  return { session: caller?.id ?? null, supervisor: caller !== null && isSupervisor(caller) };
}

/** Who hears about a task proposed by `proposedBy`: a proposer key, or `null` for one nobody in Trackwall proposed. */
export function proposerOf(proposedBy: ProposedBy | null): string | null {
  if (proposedBy?.supervisor) return SUPERVISOR;
  return proposedBy?.session ?? null;
}

/** The proposer key a session's own proposals and updates go under. */
export function proposerKeyOf(session: Pick<Session, "id" | "supervisor">): string {
  return isSupervisor(session) ? SUPERVISOR : session.id;
}
