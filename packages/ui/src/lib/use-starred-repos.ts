import { workspaceApi } from "@trackwall/protocol";
import { useCallback } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import { useAction } from "./use-action.ts";
import { useRemote } from "./use-remote.ts";

export interface StarredReposHandle {
  /** The starred repo ids; empty until they load, or when they cannot be read. */
  ids: readonly string[];
  /** Why the stars cannot be read or saved, such as a hand-made typo in `starredRepos`. */
  error: string | undefined;
  pending: boolean;
  toggle: (repo: string, starred: boolean) => void;
}

/** The starred repos of `workspace.yaml` (ADR-192), read once per view and again after every star or unstar. */
export function useStarredRepos(conn: Connection): StarredReposHandle {
  const load = useCallback(() => post(conn, workspaceApi.starredRepos, {}), [conn]);
  const remote = useRemote(load);
  const save = useAction((repo: string, starred: boolean) => post(conn, workspaceApi.setRepoStarred, { repo, starred }), remote.reload);
  return { ids: remote.data ?? [], error: save.error ?? remote.error, pending: save.pending, toggle: save.run };
}
