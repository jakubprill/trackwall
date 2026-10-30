import { type BoardRevision, boardApi } from "@trackwall/protocol";
import { useCallback, useEffect, useState } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import type { LiveFeed } from "./daemon-events.ts";
import { useRemote } from "./use-remote.ts";

/**
 * Polled rarely while the events are live, for items edited by hand in the board folder, which the daemon does not
 * watch; every change the daemon makes comes at once as a new revision (`board.changed`, ADR-133).
 */
const LIVE_POLL_MS = 30_000;
const POLL_MS = 5000;

export function useBoard(conn: Connection, live: LiveFeed<BoardRevision> | undefined) {
  const [revision, setRevision] = useState<number>();
  useEffect(() => live?.subscribe((board) => setRevision(board.revision)), [live]);
  const load = useCallback(() => post(conn, boardApi.board, {}), [conn]);
  return useRemote(load, { refreshKey: String(revision ?? ""), pollMs: () => (live?.isLive() ? LIVE_POLL_MS : POLL_MS) });
}
