import { type BatchRequest, type BatchRun, batchApi } from "@trackwall/protocol";
import { useCallback, useEffect, useState } from "react";
import { errorMessage, post } from "./api.ts";
import type { Connection } from "./connection.ts";
import { useRemote } from "./use-remote.ts";

/** W trakcie postęp ma być widać od razu, a komenda jest w pamięci daemona, więc odpytywanie jest tanie. */
const RUNNING_POLL_MS = 1500;
/** Bez trwającej komendy wystarczy rytm listy repo; łapie komendę zaczętą w innym oknie. */
const IDLE_POLL_MS = 10_000;

export interface BatchRunHandle {
  /** `null`, gdy komendy nie było; `undefined` przed pierwszą odpowiedzią. */
  run: BatchRun | null | undefined;
  /** Komenda trwa albo właśnie jest zaczynana. */
  running: boolean;
  /** Błąd startu, przerwania albo odpytywania. */
  error: string | undefined;
  start: (request: BatchRequest) => void;
  cancel: () => void;
}

/**
 * Ostatnia komenda zbiorcza (ADR-27), jej start i przerwanie. `onFinished` jest wołane po końcu komendy, żeby lista
 * repo pokazała nowe HEAD po synchronizacji bez czekania na swoje odpytanie.
 */
export function useBatchRun(conn: Connection, onFinished: () => void): BatchRunHandle {
  const [actionError, setActionError] = useState<string>();
  const [starting, setStarting] = useState(false);
  const load = useCallback(() => post(conn, batchApi.run, {}), [conn]);
  const remote = useRemote(load, { pollMs: (run) => (run?.finishedAt === null ? RUNNING_POLL_MS : IDLE_POLL_MS) });
  const run = remote.data;
  const finishedAt = run?.finishedAt;
  useEffect(() => {
    if (finishedAt) onFinished();
  }, [finishedAt, onFinished]);

  const { reload } = remote;
  const call = useCallback(
    (request: () => Promise<unknown>) => {
      setActionError(undefined);
      return request().then(reload, (err: unknown) => setActionError(errorMessage(err)));
    },
    [reload],
  );
  const start = useCallback(
    (request: BatchRequest) => {
      setStarting(true);
      void call(() => post(conn, batchApi.start, request)).finally(() => setStarting(false));
    },
    [conn, call],
  );
  const cancel = useCallback(() => void call(() => post(conn, batchApi.cancel, {})), [conn, call]);

  return { run, running: finishedAt === null || starting, error: actionError ?? remote.error, start, cancel };
}
