import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "./api.ts";

/** Ostatnie dane i ostatni błąd osobno: błąd odświeżenia nie zabiera widoku, który już coś pokazuje. */
export interface Remote<T> {
  data?: T;
  error?: string;
  loading: boolean;
}

/**
 * Dane z daemona dla jednego widoku. Nowe `load` (zmień je przez `useCallback`, gdy zmienia się pytanie) czyści
 * poprzednią odpowiedź; `reload` i odpytywanie zachowują ją do czasu nowej. Odpytywanie planuje następne pytanie
 * dopiero po odpowiedzi, więc wolny git nie piętrzy żądań, i pomija je, gdy okno jest schowane.
 */
export function useRemote<T>(load: (() => Promise<T>) | undefined, pollMs?: number): Remote<T> & { reload: () => void } {
  const [state, setState] = useState<Remote<T>>({ loading: true });
  const [generation, setGeneration] = useState(0);
  const previousLoad = useRef(load);

  // `generation` nie jest czytane w efekcie: jego zmiana to prośba o ponowne pobranie.
  useEffect(() => {
    if (!load) return;
    const changed = previousLoad.current !== load;
    previousLoad.current = load;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = () => {
      if (document.hidden) timer = setTimeout(next, pollMs);
      else setGeneration((g) => g + 1);
    };
    setState((prev) => (changed ? { loading: true } : { ...prev, loading: true }));
    load()
      .then(
        (data) => current && setState({ data, loading: false }),
        (err: unknown) => current && setState((prev) => ({ data: prev.data, error: errorMessage(err), loading: false })),
      )
      .finally(() => {
        if (current && pollMs !== undefined) timer = setTimeout(next, pollMs);
      });
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [load, generation, pollMs]);

  const reload = useCallback(() => setGeneration((g) => g + 1), []);
  return { ...state, reload };
}
