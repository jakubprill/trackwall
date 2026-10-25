import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "./api.ts";
import { currentRun } from "./background-run.ts";
import { useRemote } from "./use-remote.ts";

/** While it runs, progress should show at once, and the run is in the daemon's memory, so polling is cheap. */
const RUNNING_POLL_MS = 1500;
/** Without a running run the repo list's pace is enough; it catches a run started in another window. */
const IDLE_POLL_MS = 10_000;

/** A background run in the daemon's memory: a sync (`SyncRun`) or the batch command (`BatchRun`). */
interface BackgroundRun {
  /** ISO 8601. */
  startedAt: string;
  finishedAt: string | null;
}

export interface BackgroundRunHandle<R> {
  /** `null` when there was no run; `undefined` before the first response. */
  run: R | null | undefined;
  /** The run is in progress, or an action (start, cancel) is waiting for its response. */
  running: boolean;
  /** The error of an action or of polling. */
  error: string | undefined;
}

/**
 * The last background run and the actions on it (ADR-21, ADR-27). An action's result shows at once, without waiting for
 * a poll, so the start button does not unlock for a moment after the start. `onFinished` is called after the run ends,
 * so that the repo list shows the new HEAD without waiting for its own poll.
 */
export function useBackgroundRun<R extends BackgroundRun>(
  load: () => Promise<R | null>,
  onFinished: () => void,
): BackgroundRunHandle<R> & { act: (action: () => Promise<R | null>) => void } {
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [acted, setActed] = useState<{ run: R | null; afterLoad: number }>();
  const remote = useRemote(load, { pollMs: (run) => (run?.finishedAt === null ? RUNNING_POLL_MS : IDLE_POLL_MS) });
  const run = currentRun(acted, remote);
  const finishedAt = run?.finishedAt;
  useEffect(() => {
    if (finishedAt) onFinished();
  }, [finishedAt, onFinished]);

  const { reload, sentLoads } = remote;
  const act = useCallback(
    (action: () => Promise<R | null>) => {
      setPending(true);
      setActionError(undefined);
      action()
        .then(
          (result) => {
            setActed({ run: result, afterLoad: sentLoads() });
            reload();
          },
          (err: unknown) => setActionError(errorMessage(err)),
        )
        .finally(() => setPending(false));
    },
    [reload, sentLoads],
  );

  return { run, running: finishedAt === null || pending, error: actionError ?? remote.error, act };
}
