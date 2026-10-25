import { useCallback, useEffect, useRef, useState } from "react";
import { type CallErrorCode, errorCode, errorMessage } from "./api.ts";
import type { LiveFeed } from "./daemon-events.ts";
import { LoadOrder } from "./load-order.ts";
import { RefreshGate } from "./refresh-gate.ts";

/** The last data and the last error separately: a refresh error does not take away a view that already shows something. */
export interface Remote<T> {
  data?: T;
  error?: string;
  /** `error.code` from the daemon, when the view has to react to a specific error, not just show it. */
  errorCode?: CallErrorCode;
  /**
   * The data number (the request when it was sent, or a WebSocket snapshot when it arrived, `LoadOrder`); together
   * with `sentLoads` it tells whether the data comes from before a given moment (for example an action) or after it.
   */
  loadNumber?: number;
}

export type RemoteHandle<T> = Remote<T> & {
  reload: () => void;
  /** How many data numbers have been issued so far: sent requests and received snapshots. */
  sentLoads: () => number;
};

export interface RemoteOptions<T> {
  /**
   * Poll every this many ms, counted from the previous response. The function computes the pace from the latest data when
   * the next request is planned, so a response that changes the pace (for example a mise task started) plans the next
   * request at the new pace at once.
   */
  pollMs?: number | ((data: T | undefined) => number);
  /**
   * A change of the value fetches the data anew, keeping the previous data until the response (for example the repo's HEAD
   * hash). Changes during a request, or while the window is hidden, make one fetch after the response or when the window
   * shows, so a key that changes faster than the daemon answers does not cancel every response.
   */
  refreshKey?: string;
  /**
   * The same data live from the events WebSocket (§5.2, ADR-36), stable between renders (`useMemo`): every snapshot
   * replaces the data like a response, and polling waits while the topic is live. `load` stays for the first fetch,
   * `reload` and the time the connection is down.
   */
  live?: LiveFeed<T>;
}

/**
 * An action done when `afterLoad` requests had already been sent (`sentLoads()`) is newer than the data of request
 * `loadNumber`: the response to a request sent before it (including one in flight) does not see it yet.
 */
export function actionIsNewer(afterLoad: number, loadNumber: number | undefined): boolean {
  return (loadNumber ?? 0) <= afterLoad;
}

/**
 * Data from the daemon for one view. A new `load` (change it through `useCallback` when the request changes) clears the
 * previous response; `reload`, `refreshKey` and polling keep it until the new one. Polling plans the next request only
 * after the response, so a slow git does not pile up requests, and it waits while the window is hidden.
 */
export function useRemote<T>(load: (() => Promise<T>) | undefined, { pollMs, refreshKey, live }: RemoteOptions<T> = {}): RemoteHandle<T> {
  const [state, setState] = useState<Remote<T>>({});
  const [generation, setGeneration] = useState(0);
  const previousLoad = useRef(load);
  // The pace is read when the next request is planned, not in the effect's dependencies: a function created on render
  // must not send a request on every render.
  const pollRef = useRef(pollMs);
  pollRef.current = pollMs;
  const liveRef = useRef(live);
  liveRef.current = live;
  const dataRef = useRef<T | undefined>(undefined);
  const order = useRef(new LoadOrder()).current;
  // The key of this render, read when a request is sent: a request sent after a key change already covers it.
  const refreshKeyRef = useRef(refreshKey);
  refreshKeyRef.current = refreshKey;
  const [gate] = useState(() => new RefreshGate(refreshKey));
  const show = useCallback(
    (data: T, loadNumber: number) => {
      if (!order.show(loadNumber)) return;
      dataRef.current = data;
      setState({ data, loadNumber });
    },
    [order],
  );

  // `generation` is not read in the effect: its change is a request to fetch again.
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
    gate.sent(refreshKeyRef.current);
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
        if (!current) return;
        if (gate.answered(document.hidden)) setGeneration((g) => g + 1);
        else if (pollRef.current !== undefined) timer = setTimeout(next, interval());
      });
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [load, generation, show, order, gate]);

  useEffect(() => {
    if (gate.keyChanged(refreshKey, document.hidden)) setGeneration((g) => g + 1);
  }, [refreshKey, gate]);

  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden && gate.shown()) setGeneration((g) => g + 1);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [gate]);

  // A snapshot counts like a response to a request sent when it arrived. A snapshot read in the daemon just before an
  // action and received after it counts as newer than the action; the next one (at most 200 ms later) corrects it.
  useEffect(() => live?.subscribe((data) => show(data, order.next())), [live, show, order]);

  const reload = useCallback(() => setGeneration((g) => g + 1), []);
  const sentLoads = useCallback(() => order.issued(), [order]);
  return { ...state, reload, sentLoads };
}
