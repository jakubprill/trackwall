import { LOG_TAIL_MAX, type LogRecord, type LogSource, logsApi } from "@trackwall/protocol";
import { useEffect, useState } from "react";
import { errorMessage, post } from "./api.ts";
import type { Connection } from "./connection.ts";
import { mergeTail } from "./log-tail.ts";

/**
 * Odpytywanie co sekundę, póki log jest otwarty: odczyt z bufora w pamięci daemona jest tani, a WebSocket `/ws`
 * (§5.2) jeszcze nie istnieje. Pełna strona odpowiedzi znaczy, że czeka więcej, więc następne pytanie idzie od razu.
 */
const POLL_MS = 1000;

export interface LogTailState {
  records: LogRecord[];
  /** Część linii przepadła (bufor daemona albo restart daemona) i lista zaczęła się od nowa. */
  dropped: boolean;
  error?: string;
}

/** Log źródła na żywo, od ostatnich rekordów; kursor `nextSeq` z każdej odpowiedzi idzie do następnej. */
export function useLogTail(conn: Connection, source: LogSource): LogTailState {
  const [state, setState] = useState<LogTailState>({ records: [], dropped: false });
  const { kind, repo, miseTask } = source;

  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sinceSeq: number | undefined;
    setState({ records: [], dropped: false });
    const poll = () => {
      if (document.hidden) {
        timer = setTimeout(poll, POLL_MS);
        return;
      }
      post(conn, logsApi.tail, { source: { kind, repo, miseTask }, sinceSeq, limit: LOG_TAIL_MAX })
        .then((page) => {
          if (!current) return;
          // Pierwsza odpowiedź bez kursora to ostatnie rekordy, a nie dziura w logu.
          const dropped = sinceSeq !== undefined && page.dropped;
          sinceSeq = page.nextSeq;
          setState((prev) => ({ records: mergeTail(prev.records, page), dropped: prev.dropped || dropped }));
          timer = setTimeout(poll, page.records.length === LOG_TAIL_MAX ? 0 : POLL_MS);
        })
        .catch((err: unknown) => {
          if (!current) return;
          setState((prev) => ({ ...prev, error: errorMessage(err) }));
          timer = setTimeout(poll, POLL_MS);
        });
    };
    poll();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [conn, kind, repo, miseTask]);

  return state;
}
