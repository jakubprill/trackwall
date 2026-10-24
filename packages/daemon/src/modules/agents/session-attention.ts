import type { TaskState } from "@trackwall/protocol";

/**
 * Whether a running session waits for you (`Session.needsAttention`, §4.4, ADR-47). `Approval` and `Plan` wait until
 * the user answers, because the agent is blocked in the middle of a turn. `Input` (the turn ended or the agent asked
 * a question) waits only until the user has seen it: a session terminal window in front of the user (focused and
 * visible) or a key typed into the session marks it seen. A window that is in front of the user when the state
 * changes sees the new state at once. Only a change to another state makes the session unseen again, so a stronger
 * source confirming `Input` (a hook after a key) does not bring back a state the user has already seen.
 */

const WAITS_FOR_ANSWER: ReadonlySet<TaskState> = new Set(["Approval", "Plan"]);

export class SessionAttention {
  /** Windows of the session that are in front of the user; each attached window has its own key. */
  readonly #focused = new Set<object>();
  #state: TaskState | undefined;
  #seen = false;

  get waiting(): boolean {
    if (this.#state === undefined) return false;
    return WAITS_FOR_ANSWER.has(this.#state) || (this.#state === "Input" && !this.#seen);
  }

  /** The session's state, after every change the detectors report. */
  state(state: TaskState): void {
    if (state === this.#state) return;
    this.#state = state;
    this.#seen = this.#focused.size > 0;
  }

  /** A session terminal window came in front of the user or left. */
  focus(window: object, focused: boolean): void {
    if (!focused) {
      this.#focused.delete(window);
      return;
    }
    this.#focused.add(window);
    this.#seen = true;
  }

  /** The user typed into the session: nobody types into a session without looking at it. */
  typed(): void {
    this.#seen = true;
  }
}
