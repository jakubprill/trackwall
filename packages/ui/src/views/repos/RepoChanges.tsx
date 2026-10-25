import { countLabel, workspaceApi } from "@trackwall/protocol";
import { useCallback } from "react";
import { ChangesDiff } from "@/components/ChangesDiff";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { REPO_LIST_PACE } from "@/lib/repo-changes";
import { useRemote } from "@/lib/use-remote";

/**
 * A repo's "Changes" tab (ADR-34): the files and diff of the working directory against HEAD, with new files, read-only.
 * Polled as often as the repo list without repo events (the next request after the response, so a slow git in a big repo
 * does not pile up requests), because the repo watch does not see uncommitted changes (ADR-63), and anew after a new commit
 * (`refreshKey`: HEAD).
 */
export function RepoChanges({ conn, repo, refreshKey }: { conn: Connection; repo: string; refreshKey: string }) {
  const load = useCallback(() => post(conn, workspaceApi.changes, { repo }), [conn, repo]);
  const changes = useRemote(load, { pollMs: REPO_LIST_PACE.polled, refreshKey });
  if (changes.error && !changes.data) return <ErrorWithRetry message={changes.error} onRetry={changes.reload} />;
  if (!changes.data) return <Loading />;
  const { files } = changes.data;
  if (files.length === 0) return <p className="text-muted-foreground text-sm">The working directory has no uncommitted changes.</p>;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="text-muted-foreground text-xs">
        {countLabel(files.length, { one: "file", other: "files" })} with uncommitted changes. Commit or discard them in your editor; sync
        never touches them.
      </p>
      <ChangesDiff changes={changes.data} />
    </div>
  );
}
