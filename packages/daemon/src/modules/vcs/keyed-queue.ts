/**
 * Kolejka per klucz: zadania z tym samym kluczem idą po kolei, z różnymi równolegle. Następne zadanie czeka na
 * koniec poprzedniego, nie na jego sukces; błąd dostaje tylko wołający.
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
