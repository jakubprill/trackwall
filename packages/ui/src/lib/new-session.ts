import { isFreeSession, type Session } from "@trackwall/protocol";
import { isLive } from "./session-state.ts";

/**
 * What the New session form starts (ADR-100): a task in its own worktree (ADR-31), a main session in a repo's own
 * working copy, or a free session in the projects folder; the last two with the prompt as their first message when
 * there is one. A task needs a prompt, so without one there is nothing to start.
 */

export type NewSessionStart =
  | { kind: "task"; repo: string; prompt: string }
  | { kind: "session"; repo: string | null; prompt: string | undefined }
  | { kind: "needs-prompt" }
  | { kind: "needs-repo" };

/** `repo` is `null` for the projects folder; `worktree` is the form's choice, which the projects folder does not have. */
export function newSessionStart(repo: string | null, worktree: boolean, prompt: string): NewSessionStart {
  const text = prompt.trim();
  if (repo !== null && worktree) return text === "" ? { kind: "needs-prompt" } : { kind: "task", repo, prompt: text };
  return { kind: "session", repo, prompt: text === "" ? undefined : text };
}

/** The board item the form starts a task for (ADR-133): its id for `Task.item`, its repos and the prompt to start from. */
export interface FromItem {
  item: string;
  repos: readonly string[];
  prompt: string;
}

/** The form as it opens: in Sessions for a task or a session, from a board item only for a task on that item. */
export interface NewSessionForm {
  heading: string;
  item: string | null;
  repos: readonly string[];
  prompt: string;
  /** Whether the form may start a session, which has no place for an item, and so offers the projects folder. */
  sessions: boolean;
}

export function newSessionForm(fromItem: FromItem | undefined): NewSessionForm {
  return fromItem
    ? { heading: "New task for this item", ...fromItem, sessions: false }
    : { heading: "New task or session for the agent", item: null, repos: [], prompt: "", sessions: true };
}

/** What the form starts; a form for an item only a task, so in the projects folder nothing until a repo is chosen. */
export function formStart(form: NewSessionForm, repo: string | null, worktree: boolean, prompt: string): NewSessionStart {
  if (form.sessions) return newSessionStart(repo, worktree, prompt);
  return repo === null ? { kind: "needs-repo" } : newSessionStart(repo, true, prompt);
}

/**
 * The running sessions that already work where a new session without its own worktree would: the main sessions in the
 * repo's root, or the free sessions in the projects folder. Two agents in one working copy change each other's files.
 */
export function sessionsInSameFolder(sessions: readonly Session[], repo: string | null): Session[] {
  return sessions.filter((s) => isLive(s) && s.task === null && (repo === null ? isFreeSession(s) : s.repo === repo));
}

/** The first of a board item's repos that the projects folder has (ADR-133), where a task for the item starts. */
export function firstListedRepo(repos: readonly string[], listed: readonly { id: string }[] | undefined): string | undefined {
  return repos.find((id) => listed?.some((r) => r.id === id));
}
