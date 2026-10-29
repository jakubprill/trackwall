import { mergeRequestsApi } from "@trackwall/protocol";
import { useCallback } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import { useDesktop, windowOpener } from "./desktop.ts";
import { MERGE_REQUEST_POLL_MS, type MergeRequestDraftText } from "./merge-request.ts";
import { useAction } from "./use-action.ts";
import { useRemote } from "./use-remote.ts";

/**
 * A task's way to a merge request (ADR-77) for its panel: the branch against the remote and the merge request from it,
 * polled while the panel is open, and the actions that push the branch and open the repo host's form.
 */
export function useTaskMergeRequest(conn: Connection, task: string, paused: boolean) {
  const load = useCallback(() => post(conn, mergeRequestsApi.get, { task }), [conn, task]);
  const remote = useRemote(paused ? undefined : load, { pollMs: MERGE_REQUEST_POLL_MS });
  const push = useAction(() => post(conn, mergeRequestsApi.push, { task }), remote.reload);
  const desktop = useDesktop();
  const openForm = useAction(async (draft: MergeRequestDraftText) => {
    // Without a desktop on the daemon's side this window opens the form itself (ADR-120, ADR-130).
    if (desktop) return post(conn, mergeRequestsApi.openForm, { task, ...draft });
    return windowOpener.openOnceKnown(async () => (await post(conn, mergeRequestsApi.formUrl, { task, ...draft })).url);
  }, remote.reload);
  return {
    state: remote.data,
    push: push.run,
    pushing: push.pending,
    openForm: openForm.run,
    opening: openForm.pending,
    error: push.error ?? openForm.error ?? remote.error,
  };
}

export type TaskMergeRequestState = ReturnType<typeof useTaskMergeRequest>;
