import { CHANGE_PARTS_MAX, type ChangePart, isFreeSession, type Session } from "@trackwall/protocol";
import { isLive } from "./session-state.ts";

/**
 * What the New session form starts (ADR-100): a task in its own worktree (ADR-31), a repo session in a repo's own
 * working copy, or a free session in the projects folder; the last two with the prompt as their first message when
 * there is one. A task needs a prompt, so without one there is nothing to start.
 */

export type NewSessionStart =
  | { kind: "task"; repo: string; prompt: string }
  | { kind: "change"; title: string; prompt: string; parts: ChangePart[] }
  | { kind: "needs-title" }
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
 * The running sessions that already work where a new session without its own worktree would: the repo sessions in the
 * repo's root, or the free sessions in the projects folder. Two agents in one working copy change each other's files.
 */
export function sessionsInSameFolder(sessions: readonly Session[], repo: string | null): Session[] {
  return sessions.filter((s) => isLive(s) && s.task === null && (repo === null ? isFreeSession(s) : s.repo === repo));
}

/** The first of a board item's repos that the projects folder has (ADR-133), where a task for the item starts. */
export function firstListedRepo(repos: readonly string[], listed: readonly { id: string }[] | undefined): string | undefined {
  return repos.find((id) => listed?.some((r) => r.id === id));
}

/** A repo the user added to a task to make it a change (ADR-171), with what that repo has to do; the repo may be unchosen. */
export interface ChangePartDraft {
  repo: string;
  note: string;
}

/**
 * A task with other repos added is a change (ADR-171): the task's repo is its first part, then the added ones in the
 * order the user put them, which is the order their merge requests are to be merged. The task's repo or one added twice
 * counts once. A change needs a title, which names its branch in every repo.
 */
export function changeStart(start: NewSessionStart, added: readonly ChangePartDraft[], title: string): NewSessionStart {
  if (start.kind !== "task") return start;
  const parts = changePartsOfForm(start.repo, added);
  if (parts.length === 1) return start;
  const text = title.trim();
  return text === ""
    ? { kind: "needs-title" }
    : { kind: "change", title: text, prompt: start.prompt, parts: parts.slice(0, CHANGE_PARTS_MAX) };
}

/** The parts the form makes: the task's repo first, then each chosen repo once, in the order the user put them. */
export function changePartsOfForm(first: string, added: readonly ChangePartDraft[]): ChangePart[] {
  const parts: ChangePart[] = [{ repo: first, note: "" }];
  for (const { repo, note } of added) if (repo !== "" && !parts.some((p) => p.repo === repo)) parts.push({ repo, note: note.trim() });
  return parts;
}

/**
 * Whether the form may add one more repo: a change has at most `CHANGE_PARTS_MAX` parts, the task's own repo among them,
 * and each of the `others` repos once.
 */
export function mayAddPart(added: readonly ChangePartDraft[], others: number): boolean {
  return added.length + 1 < CHANGE_PARTS_MAX && added.length < others;
}

/**
 * What the form starts with the repos the user added (`changeStart`), and the repo that is the change's first part, `null`
 * where the form adds no repos: only a task in its own worktree becomes a change, not a session, nor a form waiting for a repo.
 */
export function formChangeStart(
  form: NewSessionForm,
  repo: string | null,
  worktree: boolean,
  prompt: string,
  added: readonly ChangePartDraft[],
  title: string,
): { start: NewSessionStart; firstPart: string | null } {
  const start = formStart(form, repo, worktree, prompt);
  const firstPart = start.kind === "task" || start.kind === "needs-prompt" ? repo : null;
  return { start: changeStart(start, firstPart === null ? [] : added, title), firstPart };
}

/** Whether the form starts a change, with or without its title yet. */
export function startsChange(start: NewSessionStart): boolean {
  return start.kind === "change" || start.kind === "needs-title";
}

/**
 * Whether the form offers a stack trace (ADR-222): only for one task in its own worktree, whose agent writes a failing
 * test first; not for a session, which has no review of its changes, nor for a change across repos.
 */
export function offersStackTrace(start: NewSessionStart): boolean {
  return start.kind === "task" || start.kind === "needs-prompt";
}

/** The pasted stack trace to send with the task, `null` when the field is empty or only blank. */
export function stackTraceToSend(text: string): string | null {
  return text.trim() === "" ? null : text;
}
