import { miseApi, type RunningMiseTask } from "@trackwall/protocol";
import { useCallback } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import type { LiveFeed } from "./daemon-events.ts";
import { useRemote } from "./use-remote.ts";

/** Running mise tasks come live from the events WebSocket; polled only while it is not connected. */
const RUNNING_MISE_POLL_MS = 3000;

/**
 * The running mise tasks of all repos (`mise/running`, cheap: no mise run), for Home, the task panel and the repo
 * details. `live` is `undefined` for a moment after a connection change, and the list is polled until then; `off` fetches
 * nothing.
 */
export function useRunningMiseTasks(conn: Connection, live: LiveFeed<RunningMiseTask[]> | undefined, off = false) {
  const load = useCallback(() => post(conn, miseApi.running, {}), [conn]);
  return useRemote(off ? undefined : load, { pollMs: RUNNING_MISE_POLL_MS, live });
}
