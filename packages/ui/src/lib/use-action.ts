import { useState } from "react";
import { errorMessage } from "./api.ts";

/** Akcja wywołana przyciskiem: blokada na czas żądania, błąd pod przyciskiem, `onDone` z wynikiem po sukcesie (np. odświeżenie). */
export function useAction<T>(action: () => Promise<T>, onDone: (result: T) => void) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const run = () => {
    setPending(true);
    setError(undefined);
    action()
      .then(onDone, (err: unknown) => setError(errorMessage(err)))
      .finally(() => setPending(false));
  };
  return { run, pending, error };
}
