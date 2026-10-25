import { agentsApi, countLabel, type TaskChanges } from "@trackwall/protocol";
import { useCallback } from "react";
import { ChangesDiff } from "@/components/ChangesDiff";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { useRemote } from "@/lib/use-remote";
import type { TaskReview } from "@/lib/use-task-review";
import { reviewAnnotations } from "./LineComments.tsx";
import { ReviewBar } from "./ReviewBar.tsx";

/**
 * Live diff: the agent changes files within seconds, and one request is a few quick git commands on the worktree
 * (cost in ADR-31); the next one goes out only after the answer, so a slow git does not pile up requests.
 */
const POLL_MS = 2000;

/**
 * The task's "Changes" tab (ADR-31): files and diff of the worktree against the base commit, polled every 2 s while
 * the tab is open, so you can see what the agent is doing before it commits anything. `paused` stops polling
 * (the worktree disappears while the task is being ended) and keeps the last data. Lines of the diff take review comments
 * for the task's agent (ADR-62).
 */
export function TaskChangesView({ conn, task, paused, review }: { conn: Connection; task: string; paused: boolean; review: TaskReview }) {
  const load = useCallback(() => post(conn, agentsApi.taskChanges, { task }), [conn, task]);
  // An open comment form stops polling: a refresh while the agent works would move the lines under it.
  const changes = useRemote(paused || review.editing !== null ? undefined : load, { pollMs: POLL_MS });
  if (changes.error && !changes.data) return <ErrorWithRetry message={changes.error} onRetry={changes.reload} />;
  if (!changes.data) return <Loading />;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ReviewBar review={review} />
      <ChangesBody changes={changes.data} review={review} />
    </div>
  );
}

function ChangesBody({ changes, review }: { changes: TaskChanges; review: TaskReview }) {
  const { files, commits, uncommitted } = changes;
  if (files.length === 0) return <p className="text-muted-foreground text-sm">The agent has not changed anything yet.</p>;
  return (
    <>
      <p className="text-muted-foreground text-xs">
        {countLabel(files.length, { one: "file", other: "files" })} · {countLabel(commits, { one: "task commit", other: "task commits" })} ·
        uncommitted: {uncommitted} · comment on a line to send the agent a review
      </p>
      <ChangesDiff changes={changes} annotations={reviewAnnotations(review)} />
    </>
  );
}
