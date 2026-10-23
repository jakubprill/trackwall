import { useState } from "react";
import { errorMessage } from "./api.ts";

/** Akcja wywołana przyciskiem: blokada na czas żądania, błąd pod przyciskiem, `onDone` po sukcesie (np. odświeżenie). */
export function useAction(action: () => Promise<unknown>, onDone: () => void) {
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
