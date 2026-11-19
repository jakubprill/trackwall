import { z } from "zod";
import { isSupervisor, type Session, type Task } from "./agents.ts";
import type { TaskStateChange } from "./task-state.ts";

/**
 * A Copilot CLI session's state in one line (§4.4), in the words every client shows: the UI's views and the VS Code
 * extension through the viewer API (ADR-221), so the two cannot name one state differently. It comes from the process
 * group when the session is ending or has ended, otherwise from the state from the session's hooks, OSC and keys. A
 * weaker signal (confidence `medium` or `low`) is a guess (`StatusLabel.guess`, a hollow dot in the UI), because it comes
 * from inference or from a kind of notification that a recording of a real session has not confirmed yet. One state per
 * row, from a short list (ADR-261): what needs you first, then a task handed over for review, then what the agent does.
 */

/**
 * A state's tone; the UI's `lib/status-tone.ts` picks the colour for a tone, and the tokens are in `index.css` (ADR-16).
 * `review` is a task handed over for your review (ADR-261): neither good nor bad, but yours to look at.
 */
export const StatusTone = z.enum(["ok", "warning", "error", "review"]);
export type StatusTone = z.infer<typeof StatusTone>;

/**
 * A state in one line: the tone of its dot (none for a state that is neither good nor bad), the text next to it, and
 * whether it is a guess from a weaker signal (a hollow dot, ADR-261).
 */
export interface StatusLabel {
  tone?: StatusTone;
  label: string;
  guess?: boolean;
}

/** The words of the states (ADR-261): short, capitalised, and "Needs you" first wherever the agent waits for you. */
export const STATE_LABELS = {
  Working: "Working",
  Input: "Needs you: answer",
  Approval: "Needs you: approval",
  Plan: "Needs you: plan",
  Done: "Finished",
  Error: "Error",
  Stale: "Not responding",
} as const;

/** No step of the agent for a long time in the middle of a turn (`Session.stuck`, ADR-151): a hint, not a certainty. */
const STUCK_LABEL = "May be stuck";

/** `Input` the user has already seen (ADR-47): the agent is idle and no longer waits for you. */
export const IDLE_LABEL = "Idle";

/**
 * The agent is idle: the session runs in `Input` the user has already seen, so it no longer waits for you (ADR-47).
 * Whether the user has seen it is decided by the daemon in `needsAttention`.
 */
export function isIdle(session: Pick<Session, "run" | "state" | "needsAttention">): boolean {
  return session.run.kind === "running" && session.state?.state === "Input" && !session.needsAttention;
}

export function sessionStateLabel(session: Pick<Session, "run" | "state" | "needsAttention" | "stuck">): StatusLabel {
  const { run, state } = session;
  if (run.kind === "stopping") return { tone: "warning", label: "Stopping" };
  if (run.kind === "exited") {
    if (run.stoppedByUser) return { label: "Stopped" };
    return state?.state === "Error" || (state?.state !== "Done" && run.exitCode !== 0)
      ? { tone: "error", label: STATE_LABELS.Error }
      : { label: STATE_LABELS.Done };
  }
  if (!state) return { label: "State unknown" };
  // Only in place of "working": a `Stale` session prints nothing at all, which "not responding" says more strongly.
  if (session.stuck !== null && state.state === "Working") return { tone: "warning", label: STUCK_LABEL };
  return runningStateLabel(state, session.needsAttention, isIdle(session));
}

/** A task the user paused (ADR-253): its state wherever a task's shows, in place of its ended session's "stopped". */
export const PAUSED_LABEL = "Paused";

/** A task without a session: none started yet in this daemon run, or its sessions were closed. */
export const NO_SESSION_LABEL = "No session";

/** A task whose agent handed its work over (ADR-213) and now only waits for your review (ADR-261). */
export const READY_FOR_REVIEW: StatusLabel = { tone: "review", label: "Ready for review" };

/** A task whose agent said its work is over (ADR-282): handed over like one ready for review, and yours to close. */
export const READY_TO_CLOSE: StatusLabel = { tone: "review", label: "Ready to close" };

type LabelledSession = Pick<Session, "run" | "state" | "needsAttention" | "stuck">;

/**
 * The task's agent handed its work over and does nothing else now: it is idle, its session ended without an error, or
 * it has none. A session that works again, waits for you or failed says that instead (ADR-261).
 */
export function readyForReview(task: Pick<Task, "inReview" | "paused">, session: LabelledSession | undefined): boolean {
  if (!task.inReview || task.paused !== null) return false;
  if (session === undefined) return true;
  if (session.run.kind === "exited") return sessionStateLabel(session).tone !== "error";
  return isIdle(session);
}

/**
 * The task's agent said its work is over (ADR-282) and does nothing else now, as `readyForReview` tells: a session that
 * works again or waits for you says that instead, and the user's Close is refused while its agent is in a turn.
 */
export function readyToClose(task: Pick<Task, "inReview" | "readyToClose" | "paused">, session: LabelledSession | undefined): boolean {
  return task.readyToClose && readyForReview(task, session);
}

/**
 * A task's state in one line: "Paused" for a task the user paused, "Ready to close" for one whose agent said its work is
 * over, "Ready for review" for one handed over, otherwise its newest session's, if it has one.
 */
export function taskStateLabel(
  task: Pick<Task, "paused" | "inReview" | "readyToClose">,
  session: LabelledSession | undefined,
): StatusLabel {
  if (task.paused !== null) return { label: PAUSED_LABEL };
  if (readyToClose(task, session)) return READY_TO_CLOSE;
  if (readyForReview(task, session)) return READY_FOR_REVIEW;
  return session ? sessionStateLabel(session) : { label: NO_SESSION_LABEL };
}

function runningStateLabel(state: TaskStateChange, needsAttention: boolean, idle: boolean): StatusLabel {
  const label = idle ? IDLE_LABEL : STATE_LABELS[state.state];
  const guess = state.confidence === "medium" || state.confidence === "low" ? { guess: true } : {};
  if (needsAttention) return { tone: "warning", label, ...guess };
  if (idle) return { label, ...guess };
  if (state.state === "Error" || state.state === "Stale") return { tone: "error", label, ...guess };
  return { tone: "ok", label, ...guess };
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
