import { verificationApi } from "@trackwall/protocol";
import { useCallback } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import { useAction } from "./use-action.ts";
import { useRemote } from "./use-remote.ts";
import { verificationPollMs } from "./verification.ts";

/**
 * A task's verification (ADR-64) for its panel: the last one, polled faster while it runs, and the actions that start
 * and cancel it. Held by the task panel, so the Verify button in its header and the result below share one state.
 */
export function useTaskVerification(conn: Connection, task: string, paused: boolean) {
  const load = useCallback(() => post(conn, verificationApi.get, { task }), [conn, task]);
  const remote = useRemote(paused ? undefined : load, { pollMs: verificationPollMs });
  const start = useAction(() => post(conn, verificationApi.start, { task }), remote.reload);
  const cancel = useAction(() => post(conn, verificationApi.cancel, { task }), remote.reload);
  const verification = remote.data ?? null;
  return {
    verification,
    running: verification?.state === "running",
    /** The mise task of the running verification, whose run the verification section shows; `undefined` otherwise. */
    runningMiseTask: verification?.state === "running" ? verification.miseTask : undefined,
    start: start.run,
    starting: start.pending,
    cancel: cancel.run,
    cancelling: cancel.pending,
    error: start.error ?? cancel.error ?? remote.error,
  };
}

export type TaskVerificationState = ReturnType<typeof useTaskVerification>;
