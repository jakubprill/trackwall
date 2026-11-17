/**
 * Work given back to a task in review (§4.18, ADR-213, ADR-258): the user's review, "Fix" of its pipeline, its merge
 * request threads or its proposer's message take the task out of review. When the agent's next turn leaves the worktree
 * where it was (no round, ADR-168) and the agent does not report again, the work it handed over still stands, so the
 * task goes back to review instead of staying "at work" with nobody working on it. Only the turn that starts after the
 * work was given counts: a turn already running when it came may end before the agent read it. The turn's end is
 * decided when the turn ends, before its round is committed, since the next turn may start while that runs. Kept in
 * memory only; after a daemon restart such a task stays at work until its agent reports.
 */
export class ReviewReturns {
  /** Tasks taken out of review: `given` until their agent's next turn starts, then `turn`. */
  readonly #waiting = new Map<string, "given" | "turn">();

  /** Task `task` was taken out of review: its agent got work again. */
  gaveWork(task: string): void {
    this.#waiting.set(task, "given");
  }

  /** A turn of task `task`'s agent started. */
  turnStarted(task: string): void {
    if (this.#waiting.has(task)) this.#waiting.set(task, "turn");
  }

  /**
   * A turn of task `task`'s agent ended: `true` when it was the turn that answered the work given, so the task goes back
   * to review if the turn changed nothing.
   */
  turnOver(task: string): boolean {
    if (this.#waiting.get(task) !== "turn") return false;
    this.#waiting.delete(task);
    return true;
  }

  /** Task `task` reported again or ended: nothing waits for its turn any more. */
  forget(task: string): void {
    this.#waiting.delete(task);
  }
}
