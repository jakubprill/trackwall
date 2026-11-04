import { type Service, servicesApi } from "@trackwall/protocol";
import { useCallback } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import { isServiceLive } from "./service-state.ts";
import { type RemoteHandle, useRemote } from "./use-remote.ts";

/** Often while a service runs or starts (the user waits for it to be ready), rarely otherwise; the list does not ask mise. */
const POLL_LIVE_MS = 1000;
const POLL_IDLE_MS = 5000;

/** The daemon's services (ADR-45), for every view that shows them: the repo and task panels, the graph and Home. */
export function useServices(conn: Connection): RemoteHandle<Service[]> {
  const load = useCallback(() => post(conn, servicesApi.list, {}), [conn]);
  return useRemote(load, { pollMs: (list) => (list?.some(isServiceLive) ? POLL_LIVE_MS : POLL_IDLE_MS) });
}
