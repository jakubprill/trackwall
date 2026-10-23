import { useCallback, useEffect, useRef, useState } from "react";
import { type CallErrorCode, errorCode, errorMessage } from "./api.ts";

/** Ostatnie dane i ostatni błąd osobno: błąd odświeżenia nie zabiera widoku, który już coś pokazuje. */
export interface Remote<T> {
  data?: T;
  error?: string;
  /** `error.code` z daemona, gdy widok musi zareagować na konkretny błąd, a nie tylko go pokazać. */
  errorCode?: CallErrorCode;
}

export type RemoteHandle<T> = Remote<T> & { reload: () => void };

export interface RemoteOptions<T> {
  /**
   * Odpytuj co tyle ms, licząc od poprzedniej odpowiedzi. Funkcja liczy tempo z ostatnich danych w chwili planowania
   * następnego pytania, więc odpowiedź, która zmienia tempo (np. task ruszył), od razu planuje pytanie w nowym tempie.
   */
  pollMs?: number | ((data: T | undefined) => number);
  /** Zmiana wartości pobiera dane od nowa, zachowując poprzednie do czasu odpowiedzi (np. hash HEAD repo). */
  refreshKey?: string;
}

/**
 * Dane z daemona dla jednego widoku. Nowe `load` (zmień je przez `useCallback`, gdy zmienia się pytanie) czyści
 * poprzednią odpowiedź; `reload`, `refreshKey` i odpytywanie zachowują ją do czasu nowej. Odpytywanie planuje
 * następne pytanie dopiero po odpowiedzi, więc wolny git nie piętrzy żądań, i czeka, gdy okno jest schowane.
 */
export function useRemote<T>(load: (() => Promise<T>) | undefined, { pollMs, refreshKey }: RemoteOptions<T> = {}): RemoteHandle<T> {
  const [state, setState] = useState<Remote<T>>({});
  const [generation, setGeneration] = useState(0);
  const previousLoad = useRef(load);
  // Tempo czytane przy planowaniu następnego pytania, nie w zależnościach efektu: funkcja tworzona przy renderze nie
  // może wysyłać pytania przy każdym renderze.
  const pollRef = useRef(pollMs);
  pollRef.current = pollMs;
  const dataRef = useRef<T | undefined>(undefined);

  // `generation` i `refreshKey` nie są czytane w efekcie: ich zmiana to prośba o ponowne pobranie.
  useEffect(() => {
    if (!load) return;
    const changed = previousLoad.current !== load;
    previousLoad.current = load;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const interval = () => (typeof pollRef.current === "function" ? pollRef.current(dataRef.current) : pollRef.current);
    const next = () => {
      if (document.hidden) timer = setTimeout(next, interval());
      else setGeneration((g) => g + 1);
    };
    if (changed) {
      dataRef.current = undefined;
      setState({});
    }
    load()
      .then(
        (data) => {
          if (!current) return;
          dataRef.current = data;
          setState({ data });
        },
        (err: unknown) => current && setState((prev) => ({ data: prev.data, error: errorMessage(err), errorCode: errorCode(err) })),
      )
      .finally(() => {
        if (current && pollRef.current !== undefined) timer = setTimeout(next, interval());
      });
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [load, generation, refreshKey]);

  const reload = useCallback(() => setGeneration((g) => g + 1), []);
  return { ...state, reload };
}
