import type { SessionTokenBudget } from "@trackwall/protocol";

/**
 * A task session's token budget (ADR-237, §4.4): the tokens its conversation may use from this start before the daemon
 * stops the session, as the user's Stop does. The session checks it after every read of its event log, so a turn that
 * goes on and on is stopped inside the turn too, at most one read (`USAGE_READ_MS`) past the budget. It fires once:
 * the session's stop ends its cycle, and a Resume starts a new session with a budget of its own.
 */
export class TokenBudget {
  readonly #budget: number;
  readonly #onReached: () => void;
  #reached = false;

  constructor(budget: number, onReached: () => void) {
    this.#budget = budget;
    this.#onReached = onReached;
  }

  /** `used`: the tokens the conversation used since this session started. */
  check(used: number): void {
    if (this.#reached || used < this.#budget) return;
    this.#reached = true;
    this.#onReached();
  }

  view(used: number): SessionTokenBudget {
    return { budget: this.#budget, used, reached: this.#reached };
  }
}
