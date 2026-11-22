import { type ContainerHealth, containerHealthApi } from "@trackwall/protocol";
import { useMemo } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import { type RemoteOptions, useRemote } from "./use-remote.ts";

/** The daemon reads the container every 30 s (ADR-279), so the window asks no more often. */
export const CONTAINER_HEALTH_PACE = 30_000;

/**
 * The container's health (ADR-279); outside a container the daemon answers `inContainer: false` without reading anything.
 * Without a connection nothing is read.
 */
export function useContainerHealth(conn: Connection | undefined, options?: RemoteOptions<ContainerHealth>) {
  const load = useMemo(() => conn && (() => post(conn, containerHealthApi.state, {})), [conn]);
  return useRemote(load, options);
}
