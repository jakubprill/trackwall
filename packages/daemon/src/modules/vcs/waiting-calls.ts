import type { Slots } from "./slots.ts";

/**
 * Identical read-only calls joined while they wait for a slot (§4.5, ADR-111). Two callers that list the repos at once
 * (the UI and a resumed session at start) would otherwise run the same `git status` twice in every repo, and where an
 * antivirus scans each process start that doubles the warm-up. A call whose job has already started is not joined: its answer
 * may predate the question, so a refresh after a commit still gets a read that begins after it asked.
 */
export class WaitingCalls<T> {
  readonly #slots: Slots;
  readonly #waiting = new Map<string, Promise<T>>();

  constructor(slots: Slots) {
    this.#slots = slots;
  }

  run(key: string, job: () => Promise<T>): Promise<T> {
    const waiting = this.#waiting.get(key);
    if (waiting) return waiting;
    // A free slot starts the job at once, before `run` returns, and then there is nothing to join.
    let started = false;
    const call = this.#slots.run(() => {
      started = true;
      this.#waiting.delete(key);
      return job();
    });
    if (!started) this.#waiting.set(key, call);
    return call;
  }
}
