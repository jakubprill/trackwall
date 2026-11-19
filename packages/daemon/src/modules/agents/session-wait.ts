import { setTimeout as sleep } from "node:timers/promises";
import type { ReadRequestHold, Session, Task, TaskProposal, WaitStatus } from "@trackwall/protocol";

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
 * What the daemon's prompt asking the agent to read is doing when the wait looks (ADR-159): typed or given and not
 * taken yet (`sent`), or about to go in (`pending`). Either way the agent takes it into a new turn in a moment, so
 * an input box with such a prompt is not a finished turn: a proposer that sends a message and waits at once would
 * otherwise get the turn that ended before the message.
 */
const ON_ITS_WAY: ReadonlySet<ReadRequestHold> = new Set(["sent", "pending"]);

/**
 * The session's state for the waiter. A stopping session is still working until its group ends, and one that may be
 * stuck (ADR-151) is `stale` like one that does not respond. A session blocked in `Approval` or `Plan` needs someone, and
 * so does one whose turn failed (`Error` from the `errorOccurred` hook, after which it is unknown whether Copilot CLI
 * sends an end of turn). A turn that ended (`Input`) needs someone until the user has seen it, and is `idle` after that:
 * what the user saw changes nothing for the agent, which is done with its turn either way, so the wait must not go on.
 */
export function sessionWaitStatus(session: Session): WaitStatus {
  if (session.run.kind === "exited") return "exited";
  const state = session.state?.state;
  if (state === "Input" || state === "Error") {
    const hold = session.readRequest?.waitsFor;
    if (hold !== undefined && ON_ITS_WAY.has(hold)) return "working";
    return session.needsAttention || state === "Error" ? "needs_attention" : "idle";
  }
  // The other states that need someone, `Approval` and `Plan`, do so until the user answers (`SessionAttention`).
  if (session.needsAttention) return "needs_attention";
  return state === "Stale" || session.stuck !== null ? "stale" : "working";
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
