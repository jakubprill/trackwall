import { useCallback, useEffect, useRef, useState } from "react";
import { type CallErrorCode, errorCode, errorMessage } from "./api.ts";
import type { LiveFeed } from "./daemon-events.ts";
import { LoadOrder } from "./load-order.ts";

/** Ostatnie dane i ostatni błąd osobno: błąd odświeżenia nie zabiera widoku, który już coś pokazuje. */
export interface Remote<T> {
  data?: T;
  error?: string;
  /** `error.code` z daemona, gdy widok musi zareagować na konkretny błąd, a nie tylko go pokazać. */
  errorCode?: CallErrorCode;
  /**
   * Numer danych (pytanie w chwili wysłania albo migawka z WebSocketu w chwili przyjścia, `LoadOrder`); razem
   * z `sentLoads` mówi, czy dane pochodzą sprzed danej chwili (np. akcji), czy po niej.
   */
  loadNumber?: number;
}

export type RemoteHandle<T> = Remote<T> & {
  reload: () => void;
  /** Ile numerów danych wydano do tej chwili: wysłane pytania i przyjęte migawki. */
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
  const order = useRef(new LoadOrder()).current;
  const show = useCallback(
    (data: T, loadNumber: number) => {
      if (!order.show(loadNumber)) return;
      dataRef.current = data;
      setState({ data, loadNumber });
    },
    [order],
  );

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
    const loadNumber = order.next();
    load()
      .then(
        (data) => {
          if (current) show(data, loadNumber);
        },
        (err: unknown) => {
          if (!current || order.isOutdated(loadNumber)) return;
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
  }, [load, generation, refreshKey, show, order]);

  // Migawka liczy się jak odpowiedź na pytanie wysłane w chwili jej przyjścia. Migawka odczytana w daemonie tuż przed
  // akcją, a przyjęta po niej, liczy się jako nowsza od akcji; następna (najwyżej 200 ms później) ją poprawia.
  useEffect(() => live?.subscribe((data) => show(data, order.next())), [live, show, order]);

  const reload = useCallback(() => setGeneration((g) => g + 1), []);
  const sentLoads = useCallback(() => order.issued(), [order]);
  return { ...state, reload, sentLoads };
}
