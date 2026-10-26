/**
 * At most `limit` jobs at once across every caller, the rest waiting in arrival order. Unlike `mapLimit`, which bounds one
 * batch, this bounds a resource shared by many batches running at the same time (git processes, §4.5).
 */
export class Slots {
  readonly #limit: number;
  #running = 0;
  readonly #waiting: Array<() => void> = [];

  constructor(limit: number) {
    if (!(limit >= 1)) throw new Error(`Slots: limit must be at least 1, got ${limit}`);
    this.#limit = limit;
  }

  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.#running >= this.#limit) await new Promise<void>((resolve) => this.#waiting.push(resolve));
    else this.#running++;
    try {
      return await job();
    } finally {
      // The slot passes straight to the next waiting job, so a job arriving meanwhile cannot take it out of turn.
      const next = this.#waiting.shift();
      if (next) next();
      else this.#running--;
    }
  }
}
