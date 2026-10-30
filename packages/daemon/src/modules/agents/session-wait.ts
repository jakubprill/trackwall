import { setTimeout as sleep } from "node:timers/promises";
import type { Session, Task, TaskProposal, WaitStatus } from "@trackwall/protocol";

/**
 * Waiting for a session or task (`wait_for_session`, ADR-39): every session cycle reads the state from daemon memory,
 * until the state needs someone (the session is waiting for a human, is unresponsive, has ended, the proposal was
 * rejected) or the time limit passes. Polling instead of the `/ws` event source, because the wait is for one object,
 * and reading a session is a read from memory.
 */

/** The same as the session cycle (`TICK_MS` in `listed-sessions.ts`), which brings new hook records. */
const CHECK_MS = 200;

/** States in which the wait goes on. */
const UNSETTLED: ReadonlySet<WaitStatus> = new Set(["proposal_pending", "starting", "working"]);

/** What the wait found: the state and the objects it concerns. */
export interface WaitOutcome {
  status: WaitStatus;
  proposal: TaskProposal | null;
  task: Task | null;
  session: Session | null;
  /** The user's reason for `proposal_rejected` (ADR-55); `null` otherwise and when they gave none. */
  rejectionReason: string | null;
}

/** An outcome with what it is about; whatever it does not name is `null`. */
export function outcome(status: WaitStatus, parts: Partial<Omit<WaitOutcome, "status">> = {}): WaitOutcome {
  return { status, proposal: null, task: null, session: null, rejectionReason: null, ...parts };
}

/**
 * The session's state for the waiter; a stopping session is still working until its group ends. An error (`Error`
 * from the `errorOccurred` hook) also needs someone: it is unknown whether Copilot CLI sends an end of turn after it, and
 * without this the wait would return with `working` after every time limit.
 */
export function sessionWaitStatus(session: Session): WaitStatus {
  if (session.run.kind === "exited") return "exited";
  if (session.needsAttention || session.state?.state === "Error") return "needs_attention";
  return session.state?.state === "Stale" ? "stale" : "working";
}

/** `read` every cycle, until the state stops being “in progress”, `timeoutMs` passes or the client cancels the call. */
export async function waitUntilSettled(read: () => WaitOutcome, timeoutMs: number, signal: AbortSignal): Promise<WaitOutcome> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const outcome = read();
    const left = until - Date.now();
    if (!UNSETTLED.has(outcome.status) || left <= 0 || signal.aborted) return outcome;
    try {
      await sleep(Math.min(CHECK_MS, left), undefined, { signal });
    } catch {
      return read();
    }
  }
}
