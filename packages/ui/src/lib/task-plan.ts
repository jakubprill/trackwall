import type { Session, SessionView, Task } from "@trackwall/protocol";
import type { NewSessionStart } from "@/lib/new-session";
import { inTurn, isLive } from "@/lib/session-state";

/**
 * Where the plan of a task started with "Plan first" stands for the user (ADR-227): `writing`, its agent is starting or
 * in the middle of a turn; `ready`, the turn ended and the plan waits for the user's approval or reply; `resume`, no
 * session runs to approve it in. `null` for a task without a plan waiting, an approved one included.
 */
export type PlanStep = "writing" | "ready" | "resume";

export function planStep(task: Pick<Task, "plan">, session: Session | undefined): PlanStep | null {
  if (task.plan !== "planning") return null;
  if (session === undefined || !isLive(session)) return "resume";
  return session.state === null || inTurn(session) ? "writing" : "ready";
}

/** Plan first on the New session form: `unavailable` says why it cannot be on now, `null` when it can. */
export type PlanFirstOffer = { unavailable: string | null };

/**
 * Whether the form offers Plan first (ADR-227): only for a task on its own, not a session or a change, whose parts start
 * one after another. In a terminal it stays visible with why it cannot be on, since Trackwall switches Copilot CLI's
 * Plan mode only in the conversation view.
 */
export function planFirstOffer(start: Pick<NewSessionStart, "kind">, view: SessionView): PlanFirstOffer | null {
  if (start.kind === "session" || start.kind === "change" || start.kind === "needs-title") return null;
  return {
    unavailable:
      view === "conversation" ? null : "Plan first needs Chat (preview): Trackwall switches Copilot CLI's Plan mode in the conversation.",
  };
}

/** Whether the task starts with Plan first: chosen, and possible where it starts (only a task's start sends it). */
export function planFirstToSend(offer: PlanFirstOffer | null, chosen: boolean): boolean {
  return chosen && offer !== null && offer.unavailable === null;
}
