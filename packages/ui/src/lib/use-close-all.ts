import type { SessionList, Task } from "@trackwall/protocol";
import { useMemo, useState } from "react";
import type { Connection } from "./connection.ts";
import { closeOutcome, closeTasks, tasksReadyToClose } from "./ready-to-close.ts";
import { useAction } from "./use-action.ts";
import type { Remote } from "./use-remote.ts";

/** "Close all" (ADR-282): the tasks ready to close now, whether a run is at work, and what the last run did. */
export interface CloseAll {
  ready: readonly Task[];
  pending: boolean;
  /** What the last run did (`closeOutcome`), or why it failed; `undefined` before the first run. */
  outcome: string | undefined;
  run: () => void;
}

/**
 * "Close all" for the Sessions list and Home's "Needs you" (ADR-282, ADR-294): the tasks ready to close, read from the
 * session list both views show, and the run that closes them. After a run `onClosed` gets the tasks it closed, which
 * the Sessions view takes off its list at once, and the list is read again.
 */
export function useCloseAll(
  conn: Connection,
  sessions: Remote<SessionList> & { reload: () => void },
  onClosed?: (tasks: readonly string[]) => void,
): CloseAll {
  const ready = useMemo(() => tasksReadyToClose(sessions.data?.tasks ?? [], sessions.data?.sessions ?? []), [sessions.data]);
  const [outcome, setOutcome] = useState<string>();
  const action = useAction(
    () => closeTasks(conn, ready),
    (results) => {
      onClosed?.(results.filter((r) => r.refused === undefined).map((r) => r.task.id));
      setOutcome(closeOutcome(results));
      sessions.reload();
    },
  );
  return { ready, pending: action.pending, outcome: action.error ?? outcome, run: action.run };
}
