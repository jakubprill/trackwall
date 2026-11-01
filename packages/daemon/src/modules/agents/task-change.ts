/**
 * What the session of a part of a change is told about the change (ADR-171, §4.4): the parts as they are on Trackwall's
 * task list, in their order, with their repos, tasks and branches. Only facts the daemon keeps, never text an agent or
 * the user wrote, so the session can trust them (ADR-46).
 */

interface ChangePartFacts {
  task: string;
  repo: string;
  branch: string;
}

export interface ChangeFacts {
  /** Every listed part, the session's own too, in their merge order. */
  parts: ChangePartFacts[];
}
