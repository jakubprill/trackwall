import { type DayStartRun, dayStartApi } from "@trackwall/protocol";
import { useCallback } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import { type BackgroundRunHandle, useBackgroundRun } from "./use-background-run.ts";

export type DayStartHandle = BackgroundRunHandle<DayStartRun> & { start: () => void };

/** The last day start (ADR-70) and its start; `onFinished` as in `useBackgroundRun`. */
export function useDayStart(conn: Connection, onFinished: () => void): DayStartHandle {
  const load = useCallback(() => post(conn, dayStartApi.run, {}), [conn]);
  const { act, ...handle } = useBackgroundRun(load, onFinished);
  const start = useCallback(() => act(() => post(conn, dayStartApi.start, {})), [conn, act]);
  return { ...handle, start };
}
