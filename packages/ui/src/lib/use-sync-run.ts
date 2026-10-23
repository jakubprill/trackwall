import { type SyncRun, workspaceApi } from "@trackwall/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, post } from "./api.ts";
import type { Connection } from "./connection.ts";
import { useRemote } from "./use-remote.ts";

/** W trakcie postęp ma być widać od razu, a synchronizacja jest w pamięci daemona, więc odpytywanie jest tanie. */
const RUNNING_POLL_MS = 1500;
/** Bez trwającej synchronizacji wystarczy rytm listy repo; łapie synchronizację zaczętą w innym oknie. */
const IDLE_POLL_MS = 10_000;

export interface SyncRunHandle {
  /** `null`, gdy synchronizacji nie było; `undefined` przed pierwszą odpowiedzią. */
  run: SyncRun | null | undefined;
  /** Synchronizacja trwa albo właśnie jest zaczynana. */
  running: boolean;
  /** Błąd startu albo odpytywania. */
  error: string | undefined;
  start: () => void;
}

/**
 * Ostatnia synchronizacja folderu z projektami (ADR-21) i jej start. `onFinished` jest wołane, gdy synchronizacja
 * widziana w trakcie się skończy, żeby lista repo pokazała nowe HEAD bez czekania na swoje odpytanie.
 */
export function useSyncRun(conn: Connection, onFinished: () => void): SyncRunHandle {
  const [startError, setStartError] = useState<string>();
  const [starting, setStarting] = useState(false);
  // Rytm odpytywania wynika z ostatniej odpowiedzi, więc jest stanem ustawianym po niej.
  const [fast, setFast] = useState(false);
  const load = useCallback(() => post(conn, workspaceApi.syncRun, {}), [conn]);
  const remote = useRemote(load, { pollMs: fast ? RUNNING_POLL_MS : IDLE_POLL_MS });
  const run = remote.data;
  const inProgress = run?.finishedAt === null;
  useEffect(() => setFast(inProgress), [inProgress]);
  const seenRunning = useOnFinished(run, onFinished);

  const { reload } = remote;
  const start = useCallback(() => {
    setStarting(true);
    setStartError(undefined);
    post(conn, workspaceApi.sync, {})
      .then(
        (started) => {
          // Synchronizacja, która skończy się przed następnym odpytaniem, też ma odświeżyć listę.
          seenRunning.current = started.startedAt;
          reload();
        },
        (err: unknown) => setStartError(errorMessage(err)),
      )
      .finally(() => setStarting(false));
  }, [conn, reload, seenRunning]);

  return { run, running: inProgress || starting, error: startError ?? remote.error, start };
}

/**
 * Woła `onFinished`, gdy synchronizacja, którą ten widok widział w trakcie, dostanie `finishedAt`. Zwraca znacznik
 * (`startedAt`) widzianej synchronizacji, żeby start mógł go ustawić sam.
 */
function useOnFinished(run: SyncRun | null | undefined, onFinished: () => void) {
  const seenRunning = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!run) return;
    if (run.finishedAt === null) seenRunning.current = run.startedAt;
    else if (seenRunning.current === run.startedAt) {
      seenRunning.current = undefined;
      onFinished();
    }
  }, [run, onFinished]);
  return seenRunning;
}
