import { useCallback, useEffect, useRef, useState } from "react";
import { type CallErrorCode, errorCode, errorMessage } from "./api.ts";
import type { LiveFeed } from "./daemon-events.ts";

/** Ostatnie dane i ostatni błąd osobno: błąd odświeżenia nie zabiera widoku, który już coś pokazuje. */
export interface Remote<T> {
  data?: T;
  error?: string;
  /** `error.code` z daemona, gdy widok musi zareagować na konkretny błąd, a nie tylko go pokazać. */
  errorCode?: CallErrorCode;
  /**
   * Numer pytania, które dało `data`, w kolejności wysłania; razem z `sentLoads` mówi, czy dane pochodzą z pytania
   * wysłanego po danej chwili (np. po akcji), a nie z takiego, które było już w drodze.
   */
  loadNumber?: number;
}

export type RemoteHandle<T> = Remote<T> & {
  reload: () => void;
  /** Ile pytań wysłano do tej chwili. */
  sentLoads: () => number;
};

export interface RemoteOptions<T> {
  /**
   * Odpytuj co tyle ms, licząc od poprzedniej odpowiedzi. Funkcja liczy tempo z ostatnich danych w chwili planowania
   * następnego pytania, więc odpowiedź, która zmienia tempo (np. task ruszył), od razu planuje pytanie w nowym tempie.
   */
  pollMs?: number | ((data: T | undefined) => number);
  /** Zmiana wartości pobiera dane od nowa, zachowując poprzednie do czasu odpowiedzi (np. hash HEAD repo). */
  refreshKey?: string;
  /**
   * Te same dane na żywo z WebSocketu zdarzeń (§5.2, ADR-36), stałe między renderami (`useMemo`): każda migawka
   * zastępuje dane jak odpowiedź, a odpytywanie czeka, dopóki temat jest na żywo. `load` zostaje do pierwszego
   * pobrania, `reload` i na czas zerwanego połączenia.
   */
  live?: LiveFeed<T>;
}

/**
 * Akcja wykonana, gdy wysłano już `afterLoad` pytań (`sentLoads()`), jest nowsza od danych z pytania `loadNumber`:
 * odpowiedź na pytanie wysłane przed nią (także takie, które było w drodze) jeszcze jej nie widzi.
 */
export function actionIsNewer(afterLoad: number, loadNumber: number | undefined): boolean {
  return (loadNumber ?? 0) <= afterLoad;
}

/**
 * Dane z daemona dla jednego widoku. Nowe `load` (zmień je przez `useCallback`, gdy zmienia się pytanie) czyści
 * poprzednią odpowiedź; `reload`, `refreshKey` i odpytywanie zachowują ją do czasu nowej. Odpytywanie planuje
 * następne pytanie dopiero po odpowiedzi, więc wolny git nie piętrzy żądań, i czeka, gdy okno jest schowane.
 */
export function useRemote<T>(load: (() => Promise<T>) | undefined, { pollMs, refreshKey, live }: RemoteOptions<T> = {}): RemoteHandle<T> {
  const [state, setState] = useState<Remote<T>>({});
  const [generation, setGeneration] = useState(0);
  const previousLoad = useRef(load);
  // Tempo czytane przy planowaniu następnego pytania, nie w zależnościach efektu: funkcja tworzona przy renderze nie
  // może wysyłać pytania przy każdym renderze.
  const pollRef = useRef(pollMs);
  pollRef.current = pollMs;
  const liveRef = useRef(live);
  liveRef.current = live;
  const dataRef = useRef<T | undefined>(undefined);
  const sent = useRef(0);
  // Numer danych na ekranie: odpowiedź na pytanie wysłane przed migawką z WebSocketu nie zastępuje nowszej migawki.
  const shown = useRef(0);
  const show = useCallback((data: T, loadNumber: number) => {
    if (loadNumber < shown.current) return;
    shown.current = loadNumber;
    dataRef.current = data;
    setState({ data, loadNumber });
  }, []);

  // `generation` i `refreshKey` nie są czytane w efekcie: ich zmiana to prośba o ponowne pobranie.
  useEffect(() => {
    if (!load) return;
    const changed = previousLoad.current !== load;
    previousLoad.current = load;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const interval = () => (typeof pollRef.current === "function" ? pollRef.current(dataRef.current) : pollRef.current);
    const next = () => {
      if (document.hidden || liveRef.current?.isLive()) timer = setTimeout(next, interval());
      else setGeneration((g) => g + 1);
    };
    if (changed) {
      dataRef.current = undefined;
      setState({});
    }
    const loadNumber = ++sent.current;
    load()
      .then(
        (data) => {
          if (current) show(data, loadNumber);
        },
        (err: unknown) => {
          // Błąd pytania starszego niż dane na ekranie (np. migawka z WebSocketu) nic już o nich nie mówi.
          if (!current || loadNumber < shown.current) return;
          setState((prev) => ({ data: prev.data, loadNumber: prev.loadNumber, error: errorMessage(err), errorCode: errorCode(err) }));
        },
      )
      .finally(() => {
        if (current && pollRef.current !== undefined) timer = setTimeout(next, interval());
      });
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [load, generation, refreshKey, show]);

  // Migawka z WebSocketu liczy się jak odpowiedź na pytanie wysłane w chwili jej przyjścia (`sentLoads`).
  useEffect(() => live?.subscribe((data) => show(data, ++sent.current)), [live, show]);

  const reload = useCallback(() => setGeneration((g) => g + 1), []);
  const sentLoads = useCallback(() => sent.current, []);
  return { ...state, reload, sentLoads };
}
