import { type ProposedBy, type Session, TASK_UPDATES_KEPT, type TaskState, type TaskUpdate } from "@trackwall/protocol";

/**
 * Task updates (ADR-68): what happened to delegated work, queued per proposer until it reads them with `get_updates`.
 * The proposer is the session that proposed the task, or, for the supervisor's work, whichever supervisor runs now
 * (`SUPERVISOR`), so a replaced supervisor's work still reaches the new one, as the Sessions view keeps it under the
 * Supervisor heading (ADR-58). An agent outside Trackwall has no input box to be woken in and gets none. Only in daemon
 * memory: at most `TASK_UPDATES_KEPT` unread per proposer, the oldest dropping out.
 */

/** The proposer key of the supervisor's work; session ids are UUIDs, so it never names a session. */
export const SUPERVISOR = "supervisor";

/** Who hears about a task proposed by `proposedBy`: a proposer key, or `null` for a task nobody in Trackwall proposed. */
export function proposerOf(proposedBy: ProposedBy | null): string | null {
  if (proposedBy?.supervisor) return SUPERVISOR;
  return proposedBy?.session ?? null;
}

export class TaskUpdates {
  readonly #unread = new Map<string, TaskUpdate[]>();
  readonly #dropped = new Map<string, number>();

  add(proposer: string, update: TaskUpdate): void {
    const unread = [...(this.#unread.get(proposer) ?? []), update];
    const over = unread.length - TASK_UPDATES_KEPT;
    if (over > 0) this.#dropped.set(proposer, (this.#dropped.get(proposer) ?? 0) + over);
    this.#unread.set(proposer, unread.slice(Math.max(0, over)));
  }

  unread(proposer: string): number {
    return this.#unread.get(proposer)?.length ?? 0;
  }

  /** The unread updates and how many dropped out before them, which from now on count as read. */
  take(proposer: string): { updates: TaskUpdate[]; dropped: number } {
    const result = { updates: this.#unread.get(proposer) ?? [], dropped: this.#dropped.get(proposer) ?? 0 };
    this.forget(proposer);
    return result;
  }

  /** A closed session hears nothing more. */
  forget(proposer: string): void {
    this.#unread.delete(proposer);
    this.#dropped.delete(proposer);
  }
}

/** What a task session's state change tells its proposer: an update without the task, session and time. */
type SessionChange = { kind: "turn_ended" } | { kind: "error" } | { kind: "exited"; exitCode: number | null; stoppedByUser: boolean };

/**
 * Follows one task session for its proposer, from views read every session cycle: a turn that ended after the agent
 * worked (not the waiting right after a start or a resume), an error and the end of the process, each once. A turn the
 * user drove (they put text into the input box during it or before it) gives nothing, since the user is the one
 * talking to the task then. A change shorter than one cycle (a turn that ends and starts again within 200 ms) is not seen.
 */
export class TurnWatch {
  #last: TaskState | "exited" | undefined;
  #userDrove = false;

  /** The user put text into the session's input box. */
  userTyped(): void {
    this.#userDrove = true;
  }

  next(view: Session): SessionChange | undefined {
    const now = view.run.kind === "exited" ? "exited" : view.state?.state;
    const previous = this.#last;
    this.#last = now;
    if (now === previous) return undefined;
    if (view.run.kind === "exited") return { kind: "exited", exitCode: view.run.exitCode, stoppedByUser: view.run.stoppedByUser };
    if (now === "Error") return { kind: "error" };
    if (now !== "Input" || (previous !== "Working" && previous !== "Stale")) return undefined;
    const userDrove = this.#userDrove;
    this.#userDrove = false;
    return userDrove ? undefined : { kind: "turn_ended" };
  }
}
