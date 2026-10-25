import type { TaskState } from "@trackwall/protocol";

/**
 * Whether a running session waits for you (`Session.needsAttention`, §4.4, ADR-47). `Approval` and `Plan` wait until
 * the user answers, because the agent is blocked in the middle of a turn. `Input` (the turn ended or the agent asked
 * a question) waits only until the user has seen it: a session terminal in front of the user (focused and
 * visible) or a key typed into the session marks it seen. A window that is in front of the user when the state
 * changes sees the new state at once. Only a change to another state makes the session unseen again, so a stronger
 * source confirming `Input` (a hook after a key) does not bring back a state the user has already seen. The state
 * itself lives with the session; this class only remembers whether the user has seen it.
 */

const WAITS_FOR_ANSWER: ReadonlySet<TaskState> = new Set(["Approval", "Plan"]);

/** One session terminal as attention sees it. */
export interface AttentionWindow {
  /** The window came in front of the user (focused and visible) or left. */
  focus(focused: boolean): void;
  /** The window is gone; it no longer counts as in front of the user. */
  close(): void;
}

export class SessionAttention {
  readonly #focused = new Set<AttentionWindow>();
  #seen = false;

  waiting(state: TaskState | undefined): boolean {
    if (state === undefined) return false;
    return WAITS_FOR_ANSWER.has(state) || (state === "Input" && !this.#seen);
  }

  /** The session's state changed from `previous` to `next`; reported after every change of the detectors. */
  changed(previous: TaskState | undefined, next: TaskState): void {
    if (previous !== next) this.#seen = this.#focused.size > 0;
  }

  window(): AttentionWindow {
    const window: AttentionWindow = {
      focus: (focused) => {
        if (!focused) {
          this.#focused.delete(window);
          return;
        }
        this.#focused.add(window);
        this.#seen = true;
      },
      close: () => {
        this.#focused.delete(window);
      },
    };
    return window;
  }

  /** The user typed into the session: nobody types into a session without looking at it. */
  typed(): void {
    this.#seen = true;
  }
}
