/**
 * A per-key queue: jobs with the same key run one after another, with different keys in parallel. The next job waits for the
 * end of the previous one, not for its success; only the caller gets the error.
 */
export class KeyedQueue {
  readonly #tails = new Map<string, Promise<void>>();

  run<T>(key: string, job: () => Promise<T>): Promise<T> {
    const result = (this.#tails.get(key) ?? Promise.resolve()).then(job);
    const done = result.then(
      () => {},
      () => {},
    );
    this.#tails.set(key, done);
    void done.then(() => {
      if (this.#tails.get(key) === done) this.#tails.delete(key);
    });
    return result;
  }
}
