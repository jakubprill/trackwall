import { type DayStartRun, dayStartApi, type SessionView } from "@trackwall/protocol";
import { useCallback } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import { type BackgroundRunHandle, useBackgroundRun } from "./use-background-run.ts";

export type DayStartHandle = BackgroundRunHandle<DayStartRun> & { start: (view: SessionView) => void };

/** The last day start (ADR-70) and its start, with the view its supervisor shows in (ADR-107); `onFinished` as in `useBackgroundRun`. */
export function useDayStart(conn: Connection, onFinished: () => void): DayStartHandle {
  const load = useCallback(() => post(conn, dayStartApi.run, {}), [conn]);
  const { act, ...handle } = useBackgroundRun(load, onFinished);
  const start = useCallback((view: SessionView) => act(() => post(conn, dayStartApi.start, { view })), [conn, act]);
  return { ...handle, start };
}
