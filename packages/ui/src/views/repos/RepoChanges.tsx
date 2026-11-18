import { countLabel, type WorkingTreeChanges, workspaceApi } from "@trackwall/protocol";
import { useCallback } from "react";
import { ChangesDiff } from "@/components/ChangesDiff";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { WORKING_TREE_POLL_MS } from "@/lib/repo-status";
import { type RemoteHandle, useRemote } from "@/lib/use-remote";
import { PutAsideList } from "./PutAsideList.tsx";

/**
 * A repo's "Changes" tab (ADR-34): the files and diff of the working directory against HEAD, with new files, read-only.
 * Polled (the next request after the response, so a slow git in a big repo does not pile up requests), because the repo
 * watch does not see uncommitted changes (ADR-63), and anew after a new commit (`refreshKey`: HEAD). Above them, the
 * changes a pull put aside (ADR-271).
 */
export function RepoChanges({ conn, repo, refreshKey }: { conn: Connection; repo: string; refreshKey: string }) {
  const load = useCallback(() => post(conn, workspaceApi.changes, { repo }), [conn, repo]);
  const changes = useRemote(load, { pollMs: WORKING_TREE_POLL_MS, refreshKey });
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PutAsideList conn={conn} repo={repo} refreshKey={refreshKey} />
      <WorkingTree changes={changes} />
    </div>
  );
}

function WorkingTree({ changes }: { changes: RemoteHandle<WorkingTreeChanges> }) {
  if (changes.error && !changes.data) return <ErrorWithRetry message={changes.error} onRetry={changes.reload} />;
  if (!changes.data) return <Loading />;
  const { files } = changes.data;
  if (files.length === 0) return <p className="text-muted-foreground text-sm">The working directory has no uncommitted changes.</p>;
  return (
    <>
      <p className="text-muted-foreground text-xs">
        {countLabel(files.length, { one: "file", other: "files" })} with uncommitted changes. Commit or discard them in your editor; sync
        never touches them, and a pull puts them aside only when you ask.
      </p>
      <ChangesDiff changes={changes.data} />
    </>
  );
}
