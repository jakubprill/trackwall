import type { Session } from "@trackwall/protocol";
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
  const label = STATE_LABELS[state.state];
  const likely = state.confidence === "medium" || state.confidence === "low" ? `probably ${label}` : label;
  if (session.needsAttention) return { tone: "warning", label: likely };
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

export function waitingCount(sessions: readonly Session[]): number {
  return sessions.filter((s) => s.needsAttention).length;
}
