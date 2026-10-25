import { useState } from "react";
import { errorMessage } from "./api.ts";

/**
 * An action triggered by a button: locked for the duration of the request, the error under the button, `onDone` with
 * the result after success (for example a refresh). The arguments of `run` go to `action` when several buttons send the
 * same request with different fields.
 */
export function useAction<A extends unknown[], T>(action: (...args: A) => Promise<T>, onDone: (result: T) => void) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const run = (...args: A) => {
    setPending(true);
    setError(undefined);
    action(...args)
      .then(onDone, (err: unknown) => setError(errorMessage(err)))
      .finally(() => setPending(false));
  };
  return { run, pending, error };
}
