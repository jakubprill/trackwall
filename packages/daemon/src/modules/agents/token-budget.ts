import type { SessionTokenBudget } from "@trackwall/protocol";

/**
 * A task session's token budget (ADR-237, §4.4): the tokens its conversation may use from this start before the daemon
 * stops the session, as the user's Stop does. The session checks it after every read of its event log, so a turn that
 * goes on and on is stopped inside the turn too, at most one read (`USAGE_READ_MS`) past the budget. It stops once; a
 * stop that fails is tried again at the next check, so a session the budget reached does not run on. A Resume starts a
 * new session with a budget of its own.
 */
export class TokenBudget {
  readonly #budget: number;
  /** The tokens (input and output) the conversation used since this session started. */
  readonly #used: () => number;
  readonly #stop: () => Promise<void>;
  #reached = false;
  #stopping = false;

  constructor(budget: number, used: () => number, stop: () => Promise<void>) {
    this.#budget = budget;
    this.#used = used;
    this.#stop = stop;
  }

  check(): void {
    if (this.#stopping || this.#used() < this.#budget) return;
    this.#reached = true;
    this.#stopping = true;
    this.#stop().catch(() => {
      this.#stopping = false;
    });
  }

  view(): SessionTokenBudget {
    return { budget: this.#budget, used: this.#used(), reached: this.#reached };
  }
}
