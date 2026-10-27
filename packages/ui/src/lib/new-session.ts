import { isFreeSession, type Session } from "@trackwall/protocol";
import { isLive } from "./session-state.ts";

/**
 * What the New session form starts (ADR-100): a task in its own worktree (ADR-31), a main session in a repo's own
 * working copy, or a free session in the projects folder; the last two with the prompt as their first message when
 * there is one. A task needs a prompt, so without one there is nothing to start.
 */

/** The value of the form's place choice for the projects folder; a repo id is never empty. */
export const PROJECTS_FOLDER = "";

export type NewSessionStart =
  | { kind: "task"; repo: string; prompt: string }
  | { kind: "session"; repo: string | null; prompt: string | undefined }
  | { kind: "needs-prompt" };

/** `place` is a repo id or `PROJECTS_FOLDER`; `worktree` is the form's choice, which the projects folder does not have. */
export function newSessionStart(place: string, worktree: boolean, prompt: string): NewSessionStart {
  const text = prompt.trim();
  const repo = place === PROJECTS_FOLDER ? null : place;
  if (repo !== null && worktree) return text === "" ? { kind: "needs-prompt" } : { kind: "task", repo, prompt: text };
  return { kind: "session", repo, prompt: text === "" ? undefined : text };
}

/**
 * The running sessions that already work where a new session without its own worktree would: the main sessions in the
 * repo's root, or the free sessions in the projects folder. Two agents in one working copy change each other's files.
 */
export function sessionsInSameFolder(sessions: readonly Session[], place: string): Session[] {
  const repo = place === PROJECTS_FOLDER ? null : place;
  return sessions.filter((s) => isLive(s) && s.task === null && (repo === null ? isFreeSession(s) : s.repo === repo));
}
