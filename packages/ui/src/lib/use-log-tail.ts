import { LOG_TAIL_MAX, type LogRecord, type LogSource, logsApi } from "@trackwall/protocol";
import { useMemo, useRef } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import { mergeTail } from "./log-tail.ts";
import { singleFlight } from "./single-flight.ts";
import { useRemote } from "./use-remote.ts";

/**
 * Odpytywanie co sekundę, póki log jest otwarty: odczyt z bufora w pamięci daemona jest tani, a WebSocket `/ws`
 * (§5.2) jeszcze nie istnieje. Pełna strona odpowiedzi znaczy, że czeka więcej, więc następne pytanie idzie od razu.
 */
const POLL_MS = 1000;

export interface LogView {
  records: LogRecord[];
  /** Część linii przepadła (bufor daemona albo restart daemona) i lista zaczęła się od nowa. */
  dropped: boolean;
  /** Ostatnia odpowiedź była pełna: daemon ma więcej rekordów po kursorze. */
  full: boolean;
}

/**
 * Log źródła na żywo, od ostatnich rekordów; kursor `nextSeq` z każdej odpowiedzi idzie do następnej. Odpytywanie,
 * schowane okno i błędy obsługuje `useRemote`; tu zostaje kursor i sklejanie stron.
 */
export function useLogTail(conn: Connection, source: LogSource) {
  // Źródło jako klucz: nowy obiekt z tymi samymi polami przy każdym renderze nie zaczyna logu od nowa.
  const key = JSON.stringify(source);
  const sourceRef = useRef(source);
  sourceRef.current = source;

  // `key` to treść źródła, samo źródło jest czytane z referencji. Stan kursora żyje w domknięciu: gdy React
  // wyrzuci je z pamięci, log zaczyna się od ostatnich rekordów, jak po otwarciu.
  const load = useMemo(() => {
    let sinceSeq: number | undefined;
    let view: LogView = { records: [], dropped: false, full: false };
    return singleFlight(async (): Promise<LogView> => {
      const page = await post(conn, logsApi.tail, { source: sourceRef.current, sinceSeq, limit: LOG_TAIL_MAX });
      // Pierwsza odpowiedź bez kursora to ostatnie rekordy, a nie dziura w logu.
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
