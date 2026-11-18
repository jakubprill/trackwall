import { type PutAside, workspaceApi } from "@trackwall/protocol";
import { useCallback, useState } from "react";
import { Surface } from "@/components/Surface";
import { Button } from "@/components/ui/button";
import { errorMessage, post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { putAsideLabel } from "@/lib/put-aside";
import { useRemote } from "@/lib/use-remote";

/**
 * "Put aside by Trackwall" in a repo's Changes tab (ADR-271): the changes a pull moved into the stash, each with Restore
 * and Delete, so they never pile up out of sight. Delete asks once more in place, since it is the one step that loses them.
 */
export function PutAsideList({ conn, repo, refreshKey }: { conn: Connection; repo: string; refreshKey: string }) {
  const load = useCallback(() => post(conn, workspaceApi.putAsides, { repo }), [conn, repo]);
  const listed = useRemote(load, { refreshKey });
  const [error, setError] = useState<string>();
  const [deleting, setDeleting] = useState<string>();
  const [busy, setBusy] = useState(false);
  const entries = listed.data ?? [];

  const act = (request: Promise<PutAside[]>) => {
    setBusy(true);
    setError(undefined);
    request
      .then(listed.reload, (err: unknown) => setError(errorMessage(err)))
      .finally(() => {
        setBusy(false);
        setDeleting(undefined);
      });
  };
  if (entries.length === 0 && !error) return null;
  const now = new Date();
  return (
    <Surface label="Put aside by Trackwall" meta={String(entries.length)}>
      <ul className="divide-y">
        {entries.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
            <span className="min-w-0 flex-1 truncate" title={p.files.join("\n")}>
              {putAsideLabel(p, now)}
            </span>
            {deleting === p.id ? (
              <>
                <span className="text-warning">Delete these changes for good?</span>
                <Button variant="destructive" size="sm" className="h-7" disabled={busy} onClick={() => act(remove(conn, repo, p.id))}>
                  Delete
                </Button>
                <Button variant="outline" size="sm" className="h-7" onClick={() => setDeleting(undefined)}>
                  Keep
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" size="sm" className="h-7" disabled={busy} onClick={() => act(restore(conn, repo, p.id))}>
                  Restore
                </Button>
                <Button variant="ghost" size="sm" className="h-7" disabled={busy} onClick={() => setDeleting(p.id)}>
                  Delete…
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
      {error && <p className="text-destructive px-3 pb-2 text-xs break-words">{error}</p>}
    </Surface>
  );
}

function restore(conn: Connection, repo: string, id: string): Promise<PutAside[]> {
  return post(conn, workspaceApi.restorePutAside, { repo, id });
}

function remove(conn: Connection, repo: string, id: string): Promise<PutAside[]> {
  return post(conn, workspaceApi.deletePutAside, { repo, id });
}
