import { isSupervisor, type Session, type SessionList, type TaskStateChange } from "@trackwall/protocol";
import type { StatusTone } from "./repo-status.ts";

/**
 * A Copilot CLI session's state in one line (§4.4): from the process group when the session is ending or has ended,
 * otherwise from the state from the session's hooks, OSC and keys. A weaker signal (confidence `medium` or `low`) is
 * shown as "probably", because it comes from inference or from a kind of notification that a recording of a real
 * session has not confirmed yet.
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

/** What the UI calls the session above all repos (ADR-58), wherever a session is named by its place. */
export const SUPERVISOR = "Supervisor";

/** What the UI calls a session in the projects folder that is not the supervisor (ADR-100). */
const FREE_SESSION = "Free session";

/** Where a session works: its repo, or for a session in the projects folder the supervisor (ADR-58) or a free session (ADR-100). */
export function sessionPlace(session: Pick<Session, "repo" | "supervisor">): string {
  if (session.repo !== null) return session.repo;
  return session.supervisor ? SUPERVISOR : FREE_SESSION;
}

/** A session's name in a list: the repo, and the window title that tells two sessions of one repo apart. */
export function sessionTitle(session: Session): string {
  const place = sessionPlace(session);
  return session.windowTitle ? `${place} · ${session.windowTitle}` : place;
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
