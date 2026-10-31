import { type BoardRevision, boardApi } from "@trackwall/protocol";
import { useCallback } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import type { LiveFeed } from "./daemon-events.ts";
import { useRevisionRemote } from "./use-revision-remote.ts";

/**
 * Polled rarely while the events are live, for items edited by hand in the board folder, which the daemon does not
 * watch; every change the daemon makes comes at once as a new revision (`board.changed`, ADR-133).
 */
const PACE = { livePollMs: 30_000, pollMs: 5000 };

export function useBoard(conn: Connection, live: LiveFeed<BoardRevision> | undefined) {
  const load = useCallback(() => post(conn, boardApi.board, {}), [conn]);
  return useRevisionRemote(load, live, PACE);
}
