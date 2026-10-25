import type { Session, SessionList, TaskProposal, TaskStateChange } from "@trackwall/protocol";
import type { StatusTone } from "./repo-status.ts";
import { nextWaiting, type SessionEntry } from "./session-entries.ts";

/**
 * Stan sesji Copilot CLI w jednej linii (§4.4): z grupy procesów, gdy sesja się kończy albo skończyła, inaczej ze
 * stanu z hooków, OSC i klawiszy sesji. Słabszy sygnał (pewność `medium` albo `low`) jest podany jako „prawdopodobnie”, bo pochodzi
 * z wnioskowania albo z rodzaju powiadomienia, którego nie potwierdziło jeszcze nagranie prawdziwej sesji.
 */

export const STATE_LABELS = {
  Working: "working",
  Input: "waiting for you",
  Approval: "asking for approval",
  Plan: "waiting for plan approval",
  Done: "finished",
  Error: "error",
  Stale: "not responding",
} as const;

/** The status of a task proposal wherever it shows (the Sessions list, “Needs you” on the dashboard): waiting for a decision. */
export const PROPOSAL_STATUS = { tone: "warning", label: "waiting for your decision" } as const;

/** The name of a group of task proposals (ADR-55) on the Sessions list and its grid tile: the repo for one, a count for more. */
export function proposalsName(proposals: readonly TaskProposal[]): string {
  const [only] = proposals;
  return proposals.length === 1 && only ? `${only.repo} · ${only.title}` : `${proposals.length} task proposals`;
}

/** `Input` the user has already seen (ADR-47): the agent is idle and no longer waits for you. */
export const IDLE_LABEL = "idle";

/**
 * The agent is idle: the session runs in `Input` the user has already seen, so it no longer waits for you (ADR-47).
 * Whether the user has seen it is decided by the daemon in `needsAttention`.
 */
export function isIdle(session: Session): boolean {
  return session.run.kind === "running" && session.state?.state === "Input" && !session.needsAttention;
}

/** Proces sesji jeszcze działa (także w trakcie zatrzymywania): pisze w swoim katalogu i trzyma jego pliki. */
export function isLive(session: Session): boolean {
  return session.run.kind !== "exited";
}

export function sessionStateLabel(session: Session): { tone?: StatusTone; label: string } {
  const { run, state } = session;
  if (run.kind === "stopping") return { tone: "warning", label: "stopping" };
  if (run.kind === "exited") {
    if (run.stoppedByUser) return { label: "stopped" };
    return state?.state === "Error" || (state?.state !== "Done" && run.exitCode !== 0)
      ? { tone: "error", label: "error" }
      : { label: "finished" };
  }
  if (!state) return { label: "state unknown" };
  return runningStateLabel(state, session.needsAttention, isIdle(session));
}

function runningStateLabel(state: TaskStateChange, needsAttention: boolean, idle: boolean): { tone?: StatusTone; label: string } {
  const label = idle ? IDLE_LABEL : STATE_LABELS[state.state];
  const likely = state.confidence === "medium" || state.confidence === "low" ? `probably ${label}` : label;
  if (needsAttention) return { tone: "warning", label: likely };
  if (idle) return { label: likely };
  if (state.state === "Error" || state.state === "Stale") return { tone: "error", label: likely };
  return { tone: "ok", label: likely };
}

/**
 * Alt+J (ADR-48): the entry to open, after the selected one, and whether the shortcut takes the key. In Sessions it
 * always does, so that the key never reaches a terminal; elsewhere only when something is waiting, so that ⌥J still
 * types in a text field. Since ADR-55 it goes through task proposals too, like the count on the views bar.
 */
export function nextWaitingShortcut(
  entries: readonly SessionEntry[],
  selected: SessionEntry | undefined,
  inSessionsView: boolean,
): { open: SessionEntry | undefined; taken: boolean } {
  const open = nextWaiting(entries, selected);
  return { open, taken: open !== undefined || inSessionsView };
}

/** A session's name in a list: the repo, and the window title that tells two sessions of one repo apart. */
export function sessionTitle(session: Session): string {
  return session.windowTitle ? `${session.repo} · ${session.windowTitle}` : session.repo;
}

function waitingCount(sessions: readonly Session[]): number {
  return sessions.filter((s) => s.needsAttention).length;
}

/** Na pasku widoków: sesje, które czekają na Ciebie, i propozycje zadań czekające na decyzję (ADR-39). */
export function attentionCount(list: SessionList | undefined): number {
  return list ? waitingCount(list.sessions) + list.proposals.length : 0;
}
