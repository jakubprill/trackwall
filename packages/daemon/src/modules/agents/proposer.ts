import { isSupervisor, type ProposedBy, type Session, SessionId, TaskId } from "@trackwall/protocol";
import { z } from "zod";

/**
 * Who proposed a task, as the task's messages and updates see it (ADR-68): the proposing session; for the supervisor's
 * work, whichever supervisor runs now (`SUPERVISOR`), so a replaced supervisor's work still reaches the new one, as the
 * Sessions view keeps it under the Supervisor heading (ADR-58); for a task session's work, whichever session of that
 * task runs now (`taskProposerKey`), so a resumed task keeps its subtasks (ADR-140).
 */

/** The proposer key of the supervisor's work; session ids are UUIDs, so it never names a session. */
export const SUPERVISOR = "supervisor";

const TASK_PREFIX = "task:";

/** The proposer key of the work a task's sessions proposed; the prefix keeps it apart from a session id. */
export function taskProposerKey(task: string): string {
  return `${TASK_PREFIX}${task}`;
}

/** The task behind a proposer key, or `null` when the key names the supervisor or a session. */
export function taskOfProposerKey(key: string): string | null {
  return key.startsWith(TASK_PREFIX) ? key.slice(TASK_PREFIX.length) : null;
}

/** A proposer key read back from a file: the supervisor, a task or a session. */
export const ProposerKey = z.union([z.literal(SUPERVISOR), z.templateLiteral([TASK_PREFIX, TaskId]), SessionId]);

/** `ProposedBy` of a caller: a listed session, or `null` for an agent outside Trackwall. */
export function proposedByOf(caller: Session | null): ProposedBy {
  return { session: caller?.id ?? null, supervisor: caller !== null && isSupervisor(caller), task: caller?.task ?? null };
}

/** Who hears about a task proposed by `proposedBy`: a proposer key, or `null` for one nobody in Trackwall proposed. */
export function proposerOf(proposedBy: ProposedBy | null): string | null {
  if (proposedBy?.supervisor) return SUPERVISOR;
  if (proposedBy?.task) return taskProposerKey(proposedBy.task);
  return proposedBy?.session ?? null;
}

/** The proposer key a session's own proposals and updates go under. */
export function proposerKeyOf(session: Pick<Session, "id" | "supervisor" | "task">): string {
  if (isSupervisor(session)) return SUPERVISOR;
  return session.task === null ? session.id : taskProposerKey(session.task);
}
