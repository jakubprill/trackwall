import { type Repo, type RepoList, workspaceApi } from "@trackwall/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import { REPO_BATCH_SIZE, repoBatches, withLoadedRepos } from "./repo-batches.ts";
import { type RemoteHandle, type RemoteOptions, useRemote } from "./use-remote.ts";

/**
 * The repo list of a view, loaded lazily (ADR-113): the quick list without git at once, every repo `loading`, then the
 * statuses in batches, `first` (the repos the view shows) before the rest. A refresh keeps the statuses already shown until
 * their new ones come, so the list does not flash back to `loading`. `first` is read when a round starts, not watched:
 * selecting a repo or filtering does not start a new round. Errors are the quick list's: a failed batch stops the
 * round, and the next refresh asks again.
 */
export function useRepoList(
  conn: Connection,
  options: RemoteOptions<RepoList>,
  first: { readonly current: readonly string[] },
): RemoteHandle<RepoList> {
  const load = useCallback(() => post(conn, workspaceApi.entries, {}), [conn]);
  const entries = useRemote(load, options);
  const [loaded, setLoaded] = useState<ReadonlyMap<string, Repo>>(() => new Map());

  useEffect(() => {
    setLoaded(new Map());
  }, [conn]);

  useEffect(() => {
    const ids = entries.data?.repos.map((r) => r.id);
    if (!ids) return;
    let current = true;
    void (async () => {
      for (const batch of repoBatches(ids, first.current, REPO_BATCH_SIZE)) {
        const repos = await post(conn, workspaceApi.repos, { repos: batch }).catch(() => undefined);
        if (!current || !repos) return;
        setLoaded((prev) => new Map([...prev, ...repos.map((r): [string, Repo] => [r.id, r])]));
      }
    })();
    return () => {
      current = false;
    };
  }, [conn, entries.data, first]);

  const data = useMemo(
    () => entries.data && { ...entries.data, repos: withLoadedRepos(entries.data.repos, loaded) },
    [entries.data, loaded],
  );
  return { ...entries, data };
}
