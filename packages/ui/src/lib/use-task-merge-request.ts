import { mergeRequestsApi } from "@trackwall/protocol";
import { useCallback, useState } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import { useDesktop, windowOpener } from "./desktop.ts";
import { MERGE_REQUEST_POLL_MS, type MergeRequestDraftText } from "./merge-request.ts";
import { deliveryMessage } from "./review-drafts.ts";
import { useAction } from "./use-action.ts";
import { useRemote } from "./use-remote.ts";

/**
 * A task's way to a merge request (ADR-77) for its panel: the branch against the remote and the merge request from it,
 * polled while the panel is open, and the actions that push the branch, open the repo host's form and ask the task's
 * agent to fix a failed pipeline (ADR-197).
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
  const lookup = remote.data?.lookup;
  const commit = lookup?.kind === "found" ? (lookup.mergeRequest.pipeline?.commit ?? null) : null;
  // A note about the pipeline it was sent for: a new pipeline after the next push has not been sent.
  const [fixSent, setFixSent] = useState<{ commit: string | null; text: string }>();
  const fixPipeline = useAction(
    () => post(conn, mergeRequestsApi.fixPipeline, { task }),
    ({ delivery }) => setFixSent({ commit, text: deliveryMessage(delivery, "the failed jobs' logs") }),
  );
  return {
    state: remote.data,
    reload: remote.reload,
    push: push.run,
    pushing: push.pending,
    openForm: openForm.run,
    opening: openForm.pending,
    fixPipeline: fixPipeline.run,
    fixing: fixPipeline.pending,
    fixSent: fixSent?.commit === commit ? fixSent.text : undefined,
    error: push.error ?? openForm.error ?? fixPipeline.error ?? remote.error,
  };
}

export type TaskMergeRequestState = ReturnType<typeof useTaskMergeRequest>;
