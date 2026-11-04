import { readinessApi } from "@trackwall/protocol";
import { useCallback } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import { useRemote } from "./use-remote.ts";

/**
 * The agent readiness of every repo for "Overview" (ADR-201), fetched again after a repo change (`refreshKey`).
 * `checkAgain` first asks the daemon for a fresh check, which asks mise again about repos whose commit did not change.
 */
export function useReadiness(conn: Connection, refreshKey: string) {
  const load = useCallback(() => post(conn, readinessApi.all, { fresh: false }), [conn]);
  const remote = useRemote(load, { refreshKey });
  const { reload } = remote;
  const checkAgain = useCallback(() => {
    void post(conn, readinessApi.all, { fresh: true }).finally(reload);
  }, [conn, reload]);
  return { ...remote, checkAgain };
}

export type ReadinessHandle = ReturnType<typeof useReadiness>;
