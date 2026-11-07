import { isSupervisor, type Session } from "./agents.ts";
import type { TaskStateChange } from "./task-state.ts";

/**
 * A Copilot CLI session's state in one line (§4.4), in the words every client shows: the UI's views and the VS Code
 * extension through the viewer API (ADR-221), so the two cannot name one state differently. It comes from the process
 * group when the session is ending or has ended, otherwise from the state from the session's hooks, OSC and keys. A
 * weaker signal (confidence `medium` or `low`) is shown as "probably", because it comes from inference or from a kind of
 * notification that a recording of a real session has not confirmed yet.
 */

/** A state's tone; the UI's `lib/status-tone.ts` picks the colour for a tone, and the tokens are in `index.css` (ADR-16). */
export type StatusTone = "ok" | "warning" | "error";

/** A state in one line: the tone of its dot (none for a state that is neither good nor bad) and the text next to it. */
export interface StatusLabel {
  tone?: StatusTone;
  label: string;
}

export const STATE_LABELS = {
  Working: "working",
  Input: "waiting for you",
  Approval: "asking for approval",
  Plan: "waiting for plan approval",
  Done: "finished",
  Error: "error",
  Stale: "not responding",
} as const;

/** No step of the agent for a long time in the middle of a turn (`Session.stuck`, ADR-151): a hint, not a certainty. */
const STUCK_LABEL = "may be stuck";

/** `Input` the user has already seen (ADR-47): the agent is idle and no longer waits for you. */
export const IDLE_LABEL = "idle";

/**
 * The agent is idle: the session runs in `Input` the user has already seen, so it no longer waits for you (ADR-47).
 * Whether the user has seen it is decided by the daemon in `needsAttention`.
 */
export function isIdle(session: Pick<Session, "run" | "state" | "needsAttention">): boolean {
  return session.run.kind === "running" && session.state?.state === "Input" && !session.needsAttention;
}

export function sessionStateLabel(session: Pick<Session, "run" | "state" | "needsAttention" | "stuck">): StatusLabel {
  const { run, state } = session;
  if (run.kind === "stopping") return { tone: "warning", label: "stopping" };
  if (run.kind === "exited") {
    if (run.stoppedByUser) return { label: "stopped" };
    return state?.state === "Error" || (state?.state !== "Done" && run.exitCode !== 0)
      ? { tone: "error", label: "error" }
      : { label: "finished" };
  }
  if (!state) return { label: "state unknown" };
  // Only in place of "working": a `Stale` session prints nothing at all, which "not responding" says more strongly.
  if (session.stuck !== null && state.state === "Working") return { tone: "warning", label: STUCK_LABEL };
  return runningStateLabel(state, session.needsAttention, isIdle(session));
}

function runningStateLabel(state: TaskStateChange, needsAttention: boolean, idle: boolean): StatusLabel {
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
  return isSupervisor(session) ? SUPERVISOR : FREE_SESSION;
}

/** A session's name in a list: the repo, and the window title that tells two sessions of one repo apart. */
export function sessionTitle(session: Pick<Session, "repo" | "supervisor" | "windowTitle">): string {
  const place = sessionPlace(session);
  return session.windowTitle ? `${place} · ${session.windowTitle}` : place;
}
