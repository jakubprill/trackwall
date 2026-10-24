import { useState } from "react";
import { errorMessage } from "./api.ts";

/**
 * Akcja wywołana przyciskiem: blokada na czas żądania, błąd pod przyciskiem, `onDone` z wynikiem po sukcesie (np.
 * odświeżenie). Argumenty `run` trafiają do `action`, gdy kilka przycisków wysyła to samo żądanie z innymi polami.
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
