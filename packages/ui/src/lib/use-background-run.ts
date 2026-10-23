import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "./api.ts";
import { useRemote } from "./use-remote.ts";

/** W trakcie postęp ma być widać od razu, a przebieg jest w pamięci daemona, więc odpytywanie jest tanie. */
const RUNNING_POLL_MS = 1500;
/** Bez trwającego przebiegu wystarczy rytm listy repo; łapie przebieg zaczęty w innym oknie. */
const IDLE_POLL_MS = 10_000;

/** Przebieg w tle w pamięci daemona: synchronizacja (`SyncRun`) albo komenda zbiorcza (`BatchRun`). */
interface BackgroundRun {
  /** ISO 8601. */
  startedAt: string;
  finishedAt: string | null;
}

export interface BackgroundRunHandle<R> {
  /** `null`, gdy przebiegu nie było; `undefined` przed pierwszą odpowiedzią. */
  run: R | null | undefined;
  /** Przebieg trwa albo akcja (start, przerwanie) czeka na odpowiedź. */
  running: boolean;
  /** Błąd akcji albo odpytywania. */
  error: string | undefined;
}

/**
 * Ostatni przebieg w tle i akcje na nim (ADR-21, ADR-27). Wynik akcji pokazuje się od razu, bez czekania na
 * odpytanie, więc przycisk startu nie odblokowuje się na chwilę po starcie. `onFinished` jest wołane po końcu
 * przebiegu, żeby lista repo pokazała nowe HEAD bez czekania na swoje odpytanie.
 */
export function useBackgroundRun<R extends BackgroundRun>(
  load: () => Promise<R | null>,
  onFinished: () => void,
): BackgroundRunHandle<R> & { act: (action: () => Promise<R | null>) => void } {
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [acted, setActed] = useState<R | null>(null);
  const remote = useRemote(load, { pollMs: (run) => (run?.finishedAt === null ? RUNNING_POLL_MS : IDLE_POLL_MS) });
  // Odpowiedź akcji jest nowsza od odpytania, które zaczęło się przed nią; odpytanie z tym samym albo późniejszym
  // startem już nie.
  const run = acted && (!remote.data || remote.data.startedAt < acted.startedAt) ? acted : remote.data;
  const finishedAt = run?.finishedAt;
  useEffect(() => {
    if (finishedAt) onFinished();
  }, [finishedAt, onFinished]);

  const { reload } = remote;
  const act = useCallback(
    (action: () => Promise<R | null>) => {
      setPending(true);
      setActionError(undefined);
      action()
        .then(
          (result) => {
            setActed(result);
            reload();
          },
          (err: unknown) => setActionError(errorMessage(err)),
        )
        .finally(() => setPending(false));
    },
    [reload],
  );

  return { run, running: finishedAt === null || pending, error: actionError ?? remote.error, act };
}
