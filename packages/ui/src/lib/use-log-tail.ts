import { LOG_TAIL_MAX, type LogRecord, type LogSource, logsApi } from "@trackwall/protocol";
import { useMemo, useRef } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import { mergeTail } from "./log-tail.ts";
import { singleFlight } from "./single-flight.ts";
import { useRemote } from "./use-remote.ts";

/**
 * Polling every second while the log is open: a read from the buffer in the daemon's memory is cheap, and the `/ws`
 * WebSocket (§5.2) does not exist yet. A full response page means more is waiting, so the next request goes at once.
 */
const POLL_MS = 1000;

export interface LogView {
  records: LogRecord[];
  /** Some lines are lost (the daemon's buffer or a daemon restart) and the list started over. */
  dropped: boolean;
  /** The last response was full: the daemon has more records after the cursor. */
  full: boolean;
}

/**
 * A source's live log, from the latest records; the `nextSeq` cursor from each response goes into the next. `useRemote`
 * handles polling, the hidden window and errors; what stays here is the cursor and joining the pages.
 */
export function useLogTail(conn: Connection, source: LogSource) {
  // The source as a key: a new object with the same fields on every render does not start the log over.
  const key = JSON.stringify(source);
  const sourceRef = useRef(source);
  sourceRef.current = source;

  // `key` is the source's content; the source itself is read from a ref. The cursor state lives in the closure: when React
  // drops it from memory, the log starts from the latest records, as after opening.
  const load = useMemo(() => {
    let sinceSeq: number | undefined;
    let view: LogView = { records: [], dropped: false, full: false };
    return singleFlight(async (): Promise<LogView> => {
      const page = await post(conn, logsApi.tail, { source: sourceRef.current, sinceSeq, limit: LOG_TAIL_MAX });
      // The first response without a cursor is the latest records, not a gap in the log.
      const dropped = view.dropped || (sinceSeq !== undefined && page.dropped);
      sinceSeq = page.nextSeq;
      const records = mergeTail(view.records, page);
      const full = page.records.length === LOG_TAIL_MAX;
      if (records !== view.records || dropped !== view.dropped || full !== view.full) view = { records, dropped, full };
      return view;
    });
  }, [conn, key]);

  return useRemote(load, { pollMs: (view) => (view?.full ? 0 : POLL_MS) });
}
