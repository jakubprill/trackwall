import { type Repo, type RepoList, workspaceApi } from "@trackwall/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import { RepoStatusRounds } from "./repo-status-rounds.ts";
import { type RemoteHandle, type RemoteOptions, useRemote } from "./use-remote.ts";

export type RepoListHandle = RemoteHandle<RepoList> & {
  /** The repos the view shows: the next round asks for them first. Selecting or filtering does not start a round. */
  showFirst: (ids: readonly string[]) => void;
};

/**
 * The repo list of a view, loaded lazily (ADR-113): the quick list without git at once, every repo `loading`, then the
 * statuses in rounds of batches (`RepoStatusRounds`). A refresh keeps the statuses already shown until their new ones
 * come, so the list does not flash back to `loading`. The error is the quick list's, or else the last failed batch's.
 */
export function useRepoList(conn: Connection, options: RemoteOptions<RepoList>): RepoListHandle {
  const load = useCallback(() => post(conn, workspaceApi.entries, {}), [conn]);
  const entries = useRemote(load, options);
  const first = useRef<readonly string[]>([]);
  const [rounds, setRounds] = useState<RepoStatusRounds>();
  const [shown, setShown] = useState<{ repos: Repo[]; error?: string }>();

  useEffect(() => {
    setShown(undefined);
    const next: RepoStatusRounds = new RepoStatusRounds({
      fetch: (ids) => post(conn, workspaceApi.repos, { repos: ids }),
      first: () => first.current,
      changed: () => setShown({ repos: next.repos, error: next.error }),
    });
    setRounds(next);
    return () => next.stop();
  }, [conn]);

  useEffect(() => {
    if (rounds && entries.data) rounds.refresh(entries.data.repos);
  }, [rounds, entries.data]);

  const data = useMemo(() => entries.data && { ...entries.data, repos: shown?.repos ?? entries.data.repos }, [entries.data, shown]);
  const showFirst = useCallback((ids: readonly string[]) => {
    first.current = ids;
  }, []);
  return { ...entries, data, error: entries.error ?? shown?.error, showFirst };
}
