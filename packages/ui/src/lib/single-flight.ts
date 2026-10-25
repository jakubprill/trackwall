/**
 * A call that, while it runs, hands the same promise to every next caller. For a read with a cursor: two requests at
 * once (StrictMode runs the effect twice, `reload` during polling) would go with the same cursor, and the same page would
 * be appended twice.
 */
export function singleFlight<T>(run: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | undefined;
  return () => {
    inFlight ??= run().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}
