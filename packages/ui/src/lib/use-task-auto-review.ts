import { type AutoReviewKind, autoReviewApi } from "@trackwall/protocol";
import { useCallback } from "react";
import { post } from "./api.ts";
import { autoReviewPollMs } from "./auto-review.ts";
import type { Connection } from "./connection.ts";
import { useAction } from "./use-action.ts";
import { useRemote } from "./use-remote.ts";

/**
 * A task's automatic review of one kind (ADR-182, ADR-234) for its "Changes" tab: the last one, polled faster while it
 * runs, and its actions.
 */
export function useTaskAutoReview(conn: Connection, task: string, kind: AutoReviewKind, paused: boolean) {
  const load = useCallback(() => post(conn, autoReviewApi.get, { task, kind }), [conn, task, kind]);
  const remote = useRemote(paused ? undefined : load, { pollMs: autoReviewPollMs });
  const start = useAction(() => post(conn, autoReviewApi.start, { task, kind }), remote.reload);
  const cancel = useAction(() => post(conn, autoReviewApi.cancel, { task, kind }), remote.reload);
  const review = remote.data ?? null;
  return {
    review,
    running: review?.state === "running",
    start: start.run,
    starting: start.pending,
    cancel: cancel.run,
    cancelling: cancel.pending,
    error: start.error ?? cancel.error ?? remote.error,
  };
}
