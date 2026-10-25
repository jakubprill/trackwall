import { type SyncRun, workspaceApi } from "@trackwall/protocol";
import { useCallback } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import { type BackgroundRunHandle, useBackgroundRun } from "./use-background-run.ts";

export type SyncRunHandle = BackgroundRunHandle<SyncRun> & { start: () => void };

/** The last sync of the projects folder (ADR-21) and its start; `onFinished` as in `useBackgroundRun`. */
export function useSyncRun(conn: Connection, onFinished: () => void): SyncRunHandle {
  const load = useCallback(() => post(conn, workspaceApi.syncRun, {}), [conn]);
  const { act, ...handle } = useBackgroundRun(load, onFinished);
  const start = useCallback(() => act(() => post(conn, workspaceApi.sync, {})), [conn, act]);
  return { ...handle, start };
}
