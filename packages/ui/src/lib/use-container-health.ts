import { type ContainerHealth, containerHealthApi } from "@trackwall/protocol";
import { useCallback } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import { type RemoteOptions, useRemote } from "./use-remote.ts";

/** The container's health (ADR-279); outside a container the daemon answers `inContainer: false` without reading anything. */
export function useContainerHealth(conn: Connection, options?: RemoteOptions<ContainerHealth>) {
  const load = useCallback(() => post(conn, containerHealthApi.state, {}), [conn]);
  return useRemote(load, options);
}
