import type { Session, SessionList, TaskStateChange } from "@trackwall/protocol";
import type { StatusTone } from "./repo-status.ts";

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

/** States in which the agent is in the middle of a turn: working, or asking for approval of a step or a plan. */
const MID_TURN_STATES: ReadonlySet<TaskStateChange["state"]> = new Set(["Working", "Approval", "Plan"]);

/**
 * Closing the session would cut the agent off in the middle of a turn, so the Close button asks first. An idle
 * session, one that waits for your next prompt, one in an unknown state and one that is already stopping or has ended close
 * at once.
 */
export function closeCutsOffTurn(session: Session): boolean {
  return session.run.kind === "running" && session.state !== null && MID_TURN_STATES.has(session.state.state);
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
 * Następna sesja, która czeka na Ciebie, po bieżącej, w kolejności listy i w kółko; `undefined`, gdy żadna nie czeka.
 * Bieżąca sesja jest wybierana dopiero wtedy, gdy czeka tylko ona.
 */
export function nextWaiting(sessions: readonly Session[], current: string | undefined): Session | undefined {
  const waiting = sessions.filter((s) => s.needsAttention);
  const at = sessions.findIndex((s) => s.id === current);
  const after = waiting.find((s) => sessions.indexOf(s) > at);
  return after ?? waiting[0];
}

/**
 * Alt+J (ADR-48): the session to open, after the selected one, and whether the shortcut takes the key. In Sessions it
 * always does, so that the key never reaches a terminal; elsewhere only when a session is waiting, so that ⌥J still
 * types in a text field.
 */
export function nextWaitingShortcut(
  sessions: readonly Session[],
  selected: string | undefined,
  inSessionsView: boolean,
): { open: Session | undefined; taken: boolean } {
  const open = nextWaiting(sessions, selected);
  return { open, taken: open !== undefined || inSessionsView };
}

/** A session's name in a list: the repo, and the window title that tells two sessions of one repo apart. */
export function sessionTitle(session: Session): string {
  return session.windowTitle ? `${session.repo} · ${session.windowTitle}` : session.repo;
}

export function waitingCount(sessions: readonly Session[]): number {
  return sessions.filter((s) => s.needsAttention).length;
}

/** Na pasku widoków: sesje, które czekają na Ciebie, i propozycje zadań czekające na decyzję (ADR-39). */
export function attentionCount(list: SessionList | undefined): number {
  return list ? waitingCount(list.sessions) + list.proposals.length : 0;
}
