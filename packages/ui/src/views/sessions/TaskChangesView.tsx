import { agentsApi, countLabel, type TaskChanges } from "@trackwall/protocol";
import { useCallback } from "react";
import { ChangesDiff } from "@/components/ChangesDiff";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { useRemote } from "@/lib/use-remote";

/**
 * Live diff: the agent changes files within seconds, and one request is a few quick git commands on the worktree
 * (cost in ADR-31); the next one goes out only after the answer, so a slow git does not pile up requests.
 */
const POLL_MS = 2000;

/**
 * The task's "Changes" tab (ADR-31): files and diff of the worktree against the base commit, polled every 2 s while
 * the tab is open, so you can see what the agent is doing before it commits anything. `paused` stops polling
 * (the worktree disappears while the task is being ended) and keeps the last data.
 */
export function TaskChangesView({ conn, task, paused }: { conn: Connection; task: string; paused: boolean }) {
  const load = useCallback(() => post(conn, agentsApi.taskChanges, { task }), [conn, task]);
  const changes = useRemote(paused ? undefined : load, { pollMs: POLL_MS });
  if (changes.error && !changes.data) return <ErrorWithRetry message={changes.error} onRetry={changes.reload} />;
  if (!changes.data) return <Loading />;
  return <ChangesBody changes={changes.data} />;
}

function ChangesBody({ changes }: { changes: TaskChanges }) {
  const { files, commits, uncommitted } = changes;
  if (files.length === 0) return <p className="text-muted-foreground text-sm">The agent has not changed anything yet.</p>;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="text-muted-foreground text-xs">
        {countLabel(files.length, { one: "file", other: "files" })} · {countLabel(commits, { one: "task commit", other: "task commits" })} ·
        uncommitted: {uncommitted}
      </p>
      <ChangesDiff changes={changes} />
    </div>
  );
}
