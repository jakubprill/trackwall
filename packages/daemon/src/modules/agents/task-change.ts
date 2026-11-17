import { type ChangePart, type ChangeSessions, sharedChangePrompt } from "@trackwall/protocol";

/**
 * What the session of a part of a change is told about the change (ADR-171, §4.4): the parts as they are on Trackwall's
 * task list, in their order, with their repos, tasks and branches. Only facts the daemon keeps, never text an agent or
 * the user wrote, so the session can trust them (ADR-46).
 */

/** The one session of a change (ADR-265): what it is asked to do, the change's prompt with every part's note. */
export interface SharedChangeSession {
  prompt: string;
}

/** What `sessions` asks of a change's start: its one session with its prompt (ADR-265), or `null` for a session per part. */
export function sharedSession(sessions: ChangeSessions, prompt: string, parts: readonly ChangePart[]): SharedChangeSession | null {
  return sessions === "shared" ? { prompt: sharedChangePrompt(prompt, parts) } : null;
}

interface ChangePartFacts {
  task: string;
  repo: string;
  branch: string;
}

export interface ChangeFacts {
  /** Every listed part, the session's own too, in their merge order. */
  parts: ChangePartFacts[];
  /**
   * The change runs in one session (ADR-265): the session of the lead part works in a folder that holds every part's
   * worktree under its repo's name, and the other parts have no session.
   */
  oneSession: boolean;
}
