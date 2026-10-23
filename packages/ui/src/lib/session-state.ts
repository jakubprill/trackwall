import { type Session, sessionNeedsAttention } from "@trackwall/protocol";
import type { StatusTone } from "./repo-status.ts";

/**
 * Stan sesji Copilot CLI w jednej linii (§4.4): z grupy procesów, gdy sesja się kończy albo skończyła, inaczej ze
 * stanu z hooków i OSC. Słabszy sygnał (pewność `medium` albo `low`) jest podany jako „prawdopodobnie”, bo stan
 * pochodzi z wnioskowania, a nie z hooka, który mówi wprost.
 */

const STATE_LABELS = {
  Working: "pracuje",
  Input: "czeka na Ciebie",
  Approval: "prosi o zgodę",
  Plan: "czeka na akceptację planu",
  Done: "zakończona",
  Error: "błąd",
  Stale: "bez odpowiedzi",
} as const;

export function sessionStateLabel(session: Session): { tone?: StatusTone; label: string } {
  const { run, state } = session;
  if (run.kind === "stopping") return { tone: "warning", label: "zatrzymywanie" };
  if (run.kind === "exited") {
    if (run.stoppedByUser) return { label: "zatrzymana" };
    return state?.state === "Error" || (state?.state !== "Done" && run.exitCode !== 0)
      ? { tone: "error", label: "błąd" }
      : { label: "zakończona" };
  }
  if (!state) return { label: "uruchamia się" };
  const label = STATE_LABELS[state.state];
  const likely = state.confidence === "medium" || state.confidence === "low" ? `prawdopodobnie ${label}` : label;
  if (sessionNeedsAttention(session)) return { tone: "warning", label: likely };
  if (state.state === "Error" || state.state === "Stale") return { tone: "error", label: likely };
  return { tone: "ok", label: likely };
}

/**
 * Następna sesja czekająca na człowieka po bieżącej, w kolejności listy i w kółko; `undefined`, gdy żadna nie czeka.
 * Bieżąca sesja jest wybierana dopiero wtedy, gdy czeka tylko ona.
 */
export function nextWaiting(sessions: readonly Session[], current: string | undefined): Session | undefined {
  const waiting = sessions.filter(sessionNeedsAttention);
  const at = sessions.findIndex((s) => s.id === current);
  const after = waiting.find((s) => sessions.indexOf(s) > at);
  return after ?? waiting[0];
}

export function waitingCount(sessions: readonly Session[]): number {
  return sessions.filter(sessionNeedsAttention).length;
}
