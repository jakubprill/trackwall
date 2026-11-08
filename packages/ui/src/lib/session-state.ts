import { isSupervisor, type Session, type SessionList, type TaskStateChange } from "@trackwall/protocol";

/** The state labels moved to `protocol` (ADR-221), so the VS Code extension shows the same words; the UI keeps importing them from here. */
export { IDLE_LABEL, isIdle, STATE_LABELS, SUPERVISOR, sessionPlace, sessionStateLabel, sessionTitle } from "@trackwall/protocol";

/** The status of a task proposal wherever it shows (the Sessions list, “Needs you” on the dashboard): waiting for a decision. */
export const PROPOSAL_STATUS = { tone: "warning", label: "waiting for your decision" } as const;

/** The session's process is still running (also while stopping): it writes in its directory and holds its files. */
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
  return inTurn(session);
}

/** The agent runs and is in the middle of a turn, which the conversation view's "Stop the turn" ends. */
export function inTurn(session: Session): boolean {
  return session.run.kind === "running" && session.state !== null && MID_TURN_STATES.has(session.state.state);
}

/** How many agents are in the middle of a turn, which an update's restart would cut off (ADR-97). */
export function agentsInTurn(sessions: readonly Session[]): number {
  return sessions.filter(closeCutsOffTurn).length;
}

/** The supervisor is left out: it waits in its own panel, which shows that itself, not in the Sessions list (ADR-58). */
function waitingCount(sessions: readonly Session[]): number {
  return sessions.filter((s) => s.needsAttention && !isSupervisor(s)).length;
}

/**
 * On the view bar and the "Next waiting" button: the sessions waiting for you and the task proposals waiting for a
 * decision (ADR-39), each proposal counted, although Alt+J stops once at the group of one session (ADR-55). The
 * supervisor's proposals count too, since they are entries of the list.
 */
export function attentionCount(list: SessionList | undefined): number {
  return list ? waitingCount(list.sessions) + list.proposals.length : 0;
}

/**
 * In a browser tab's title (ADR-146): like `attentionCount`, but with the supervisor, as on the desktop app's icon
 * (`badge.rs`), since the title is all the user sees of a tab in the background.
 */
export function waitingInTab(list: SessionList | undefined): number {
  return list ? list.sessions.filter((s) => s.needsAttention).length + list.proposals.length : 0;
}
