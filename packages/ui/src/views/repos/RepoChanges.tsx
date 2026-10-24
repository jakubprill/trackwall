import { countLabel, workspaceApi } from "@trackwall/protocol";
import { useCallback } from "react";
import { ChangesDiff } from "@/components/ChangesDiff";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { REPO_LIST_POLL_MS } from "@/lib/repo-status";
import { useRemote } from "@/lib/use-remote";

/**
 * Zakładka „Changes” repo (ADR-34): pliki i diff katalogu roboczego względem HEAD, z nowymi plikami, tylko do
 * przeczytania. Odpytywana tak często jak lista repo (następne pytanie po odpowiedzi, więc wolny git w dużym repo nie
 * piętrzy pytań), bo to zmiany użytkownika, a nie agenta, i od nowa po nowym commicie (`refreshKey`: HEAD).
 */
export function RepoChanges({ conn, repo, refreshKey }: { conn: Connection; repo: string; refreshKey: string }) {
  const load = useCallback(() => post(conn, workspaceApi.changes, { repo }), [conn, repo]);
  const changes = useRemote(load, { pollMs: REPO_LIST_POLL_MS, refreshKey });
  if (changes.error && !changes.data) return <ErrorWithRetry message={changes.error} onRetry={changes.reload} />;
  if (!changes.data) return <Loading />;
  const { files } = changes.data;
  if (files.length === 0) return <p className="text-muted-foreground text-sm">The working directory has no uncommitted changes.</p>;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="text-muted-foreground text-xs">
        {countLabel(files.length, { one: "file", other: "files" })} not in the latest commit. Commit or discard them in your editor; sync
        never touches them.
      </p>
      <ChangesDiff changes={changes.data} />
    </div>
  );
}
