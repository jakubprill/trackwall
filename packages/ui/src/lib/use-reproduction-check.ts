import { reproductionApi } from "@trackwall/protocol";
import { useCallback } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import { reproductionPollMs } from "./reproduction.ts";
import { useAction } from "./use-action.ts";
import { useRemote } from "./use-remote.ts";

/** A task's reproduction check (ADR-227) for the agent's reproduction test in its panel: the last one, and starting and stopping it. */
export function useReproductionCheck(conn: Connection, task: string) {
  const load = useCallback(() => post(conn, reproductionApi.get, { task }), [conn, task]);
  const remote = useRemote(load, { pollMs: reproductionPollMs });
  const start = useAction(() => post(conn, reproductionApi.start, { task }), remote.reload);
  const cancel = useAction(() => post(conn, reproductionApi.cancel, { task }), remote.reload);
  return {
    check: remote.data ?? null,
    start: start.run,
    starting: start.pending,
    cancel: cancel.run,
    cancelling: cancel.pending,
    error: start.error ?? cancel.error ?? remote.error,
  };
}
