import { type BatchRequest, type BatchRun, batchApi } from "@trackwall/protocol";
import { useCallback } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import { type BackgroundRunHandle, useBackgroundRun } from "./use-background-run.ts";

export type BatchRunHandle = BackgroundRunHandle<BatchRun> & {
  start: (request: BatchRequest) => void;
  cancel: () => void;
};

/** The last batch command (ADR-27), its start and cancel; `onFinished` as in `useBackgroundRun`. */
export function useBatchRun(conn: Connection, onFinished: () => void): BatchRunHandle {
  const load = useCallback(() => post(conn, batchApi.run, {}), [conn]);
  const { act, ...handle } = useBackgroundRun(load, onFinished);
  const start = useCallback((request: BatchRequest) => act(() => post(conn, batchApi.start, request)), [conn, act]);
  const cancel = useCallback(() => act(() => post(conn, batchApi.cancel, {})), [conn, act]);
  return { ...handle, start, cancel };
}
